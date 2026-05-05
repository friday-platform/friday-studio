/**
 * Cross-cascade signal routing on JetStream.
 *
 * Subjects: `workspaces.<workspaceId>.signals.<signalId>` carry signal
 * envelopes. Triggers (HTTP, cron, chat handler, in-cascade emits) publish
 * here; the SIGNALS stream is workQueue + ack_explicit so messages are
 * redelivered if a worker dies mid-processing.
 *
 * This module ships the substrate (stream creation + publish helper +
 * consumer wiring) but does not yet *replace* the in-process trigger path
 * in atlas-daemon. That migration happens callsite-by-callsite — this
 * file is what they'll publish through.
 */

import { logger } from "@atlas/logger";
import { stringifyError } from "@atlas/utils";
import {
  AckPolicy,
  DeliverPolicy,
  type JsMsg,
  type NatsConnection,
  headers as natsHeaders,
  RetentionPolicy,
  StorageType,
} from "nats";
import { z } from "zod";

const STREAM_NAME = "SIGNALS";
const SCHEMA_VERSION = "1";
const DEFAULT_MAX_MSG_SIZE = 1 * 1024 * 1024;
const DEFAULT_MAX_AGE_NS = 7 * 24 * 60 * 60 * 1_000_000_000; // 7 days
const DEFAULT_DUPLICATE_WINDOW_NS = 5 * 60 * 1_000_000_000; // 5 min — covers cron-tick double-fires

/** Per-stream limits for SIGNALS, sourced from FRIDAY_JETSTREAM_* env vars. */
export interface SignalsStreamLimits {
  maxMsgSize?: number;
  maxAgeNs?: number | bigint;
  duplicateWindowNs?: number | bigint;
}

const toNumber = (v: number | bigint | undefined, fallback: number): number => {
  if (v === undefined) return fallback;
  return typeof v === "bigint" ? Number(v) : v;
};
// WorkQueue streams require DeliverPolicy.All — messages are dropped from the
// stream once acked, so "from now on" or "from sequence" deliver policies are
// rejected by the broker.
const DEFAULT_DELIVER_POLICY = DeliverPolicy.All;

const enc = new TextEncoder();
const dec = new TextDecoder();

const SAFE_TOKEN_RE = /[^A-Za-z0-9_-]/g;
const sanitizeToken = (s: string) => s.replace(SAFE_TOKEN_RE, "_");

export function signalSubject(workspaceId: string, signalId: string): string {
  return `workspaces.${sanitizeToken(workspaceId)}.signals.${sanitizeToken(signalId)}`;
}

export const SignalEnvelopeSchema = z.object({
  workspaceId: z.string().min(1),
  signalId: z.string().min(1),
  payload: z.record(z.string(), z.unknown()).optional(),
  streamId: z.string().optional(),
  /** sessionId of the cascade that emitted this signal (cross-cascade chains). */
  sourceSessionId: z.string().optional(),
  /** ISO 8601; populated by publishSignal. */
  publishedAt: z.string().datetime(),
  /** Optional opaque trace id propagated across cascades. */
  traceId: z.string().optional(),
  /**
   * If set, the consumer publishes the dispatch result to
   * `signals.responses.<correlationId>` so a synchronous publisher (HTTP
   * trigger, future cross-cascade emit-and-await) can subscribe and unblock.
   */
  correlationId: z.string().optional(),
});

export type SignalEnvelope = z.infer<typeof SignalEnvelopeSchema>;

/** Result published by SignalConsumer to the response subject. */
export const SignalResponseSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), result: z.unknown() }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);
export type SignalResponse = z.infer<typeof SignalResponseSchema>;

export function signalResponseSubject(correlationId: string): string {
  return `signals.responses.${correlationId}`;
}

export function signalStreamSubject(correlationId: string): string {
  return `signals.stream.${correlationId}`;
}

export async function ensureSignalsStream(
  nc: NatsConnection,
  limits: SignalsStreamLimits = {},
): Promise<void> {
  const jsm = await nc.jetstreamManager();
  try {
    await jsm.streams.info(STREAM_NAME);
    return;
  } catch (err) {
    const msg = String((err as { message?: string })?.message ?? err);
    if (!msg.includes("stream not found") && !msg.includes("no stream")) throw err;
  }
  await jsm.streams.add({
    name: STREAM_NAME,
    subjects: ["workspaces.*.signals.*"],
    retention: RetentionPolicy.Workqueue,
    storage: StorageType.File,
    max_msg_size: toNumber(limits.maxMsgSize, DEFAULT_MAX_MSG_SIZE),
    max_age: toNumber(limits.maxAgeNs, DEFAULT_MAX_AGE_NS),
    duplicate_window: toNumber(limits.duplicateWindowNs, DEFAULT_DUPLICATE_WINDOW_NS),
  });
  logger.info("Created SIGNALS JetStream stream");
}

export interface PublishSignalOpts {
  workspaceId: string;
  signalId: string;
  payload?: Record<string, unknown>;
  streamId?: string;
  sourceSessionId?: string;
  traceId?: string;
  /**
   * If set, the consumer publishes a SignalResponse to
   * `signals.responses.<correlationId>` after dispatch. Use
   * `awaitSignalCompletion` (or your own `nc.subscribe`) to receive it.
   */
  correlationId?: string;
}

/**
 * Publish a signal envelope onto the SIGNALS stream. Returns the broker's
 * publish sequence (not a sessionId — sessions are assigned by the consumer
 * worker when it actually runs the cascade).
 *
 * Sets `msgID` so retries within the stream's duplicate_window dedupe at
 * the broker. Callers that need a stable id across retries (e.g. cron
 * ticks that may fire twice) should pass `dedupId`; otherwise we derive
 * one from (workspaceId, signalId, publishedAt) which is stable for a
 * given publish call.
 */
export async function publishSignal(
  nc: NatsConnection,
  opts: PublishSignalOpts & { dedupId?: string },
): Promise<{ seq: number }> {
  const publishedAt = new Date().toISOString();
  const envelope: SignalEnvelope = {
    workspaceId: opts.workspaceId,
    signalId: opts.signalId,
    payload: opts.payload,
    streamId: opts.streamId,
    sourceSessionId: opts.sourceSessionId,
    publishedAt,
    traceId: opts.traceId,
    correlationId: opts.correlationId,
  };

  const h = natsHeaders();
  h.set("Friday-Schema-Version", SCHEMA_VERSION);
  if (opts.traceId) h.set("Friday-Trace-Id", opts.traceId);

  const subject = signalSubject(opts.workspaceId, opts.signalId);
  const msgID = opts.dedupId ?? `${opts.workspaceId}/${opts.signalId}/${publishedAt}`;
  const ack = await nc
    .jetstream()
    .publish(subject, enc.encode(JSON.stringify(envelope)), { headers: h, msgID });
  return { seq: ack.seq };
}

/**
 * Callback used by SignalConsumer to forward a received envelope onward.
 *
 * Historically this awaited the entire FSM cascade. As of the cascade
 * decoupling, it's a thin forward-and-ack — the daemon wires it to
 * `publishCascade` (cascade-stream.ts), which lands the envelope on the
 * CASCADES stream where a separate consumer applies the per-signal
 * concurrency policy and runs the cascade as a background Promise.
 *
 * This shape preserves the in-tree tests that stub a dispatcher; for
 * the production wiring see `apps/atlasd/src/atlas-daemon.ts` where the
 * dispatcher is `(env) => publishCascade(nc, env)`.
 */
export type SignalDispatcher = (envelope: SignalEnvelope) => Promise<unknown>;

export interface SignalConsumerOptions {
  /** Logical name for the durable consumer; defaults to "atlasd-signals". */
  name?: string;
  /** How long to wait per fetch before re-issuing. */
  expiresMs?: number;
  /** Max messages per fetch. */
  batchSize?: number;
  /** Max redelivery attempts before sending to dead-letter logging. */
  maxDeliver?: number;
  /**
   * Max in-flight unacked messages before the broker pauses delivery to
   * this consumer. Primary flow-control knob — too low starves the
   * dispatcher under burst, too high lets the worker fall behind without
   * back-pressuring the publisher. Sourced from
   * FRIDAY_JETSTREAM_MAX_ACK_PENDING.
   */
  maxAckPending?: number;
  /**
   * How long the broker waits for an ack before redelivering. Tune up
   * if signal cascades routinely exceed the default; tune down if
   * worker death latency matters more than long-running cascades.
   */
  ackWaitNs?: number | bigint;
}

/**
 * Pull-based consumer that drains the SIGNALS stream and dispatches each
 * envelope to the runtime. ack on success → broker drops the message;
 * nak on dispatch failure → broker redelivers (up to maxDeliver). After
 * maxDeliver the message is term'd and logged.
 */
export class SignalConsumer {
  private running = false;
  private loop: Promise<void> | null = null;
  private readonly name: string;
  private readonly expiresMs: number;
  private readonly batchSize: number;
  private readonly maxDeliver: number;
  private readonly maxAckPending: number;
  private readonly ackWaitNs: number;

  constructor(
    private readonly nc: NatsConnection,
    private readonly dispatch: SignalDispatcher,
    opts: SignalConsumerOptions = {},
  ) {
    this.name = opts.name ?? "atlasd-signals";
    // Broker rejects expires < 1000ms.
    this.expiresMs = Math.max(1000, opts.expiresMs ?? 10_000);
    this.batchSize = opts.batchSize ?? 16;
    this.maxDeliver = opts.maxDeliver ?? 5;
    this.maxAckPending = opts.maxAckPending ?? 256;
    this.ackWaitNs = toNumber(opts.ackWaitNs, 5 * 60 * 1_000_000_000);
  }

  async start(): Promise<void> {
    if (this.running) return;
    const jsm = await this.nc.jetstreamManager();
    try {
      await jsm.consumers.info(STREAM_NAME, this.name);
    } catch (err) {
      const msg = String((err as { message?: string })?.message ?? err);
      if (!msg.includes("consumer not found")) throw err;
      await jsm.consumers.add(STREAM_NAME, {
        durable_name: this.name,
        ack_policy: AckPolicy.Explicit,
        deliver_policy: DEFAULT_DELIVER_POLICY,
        max_deliver: this.maxDeliver,
        ack_wait: this.ackWaitNs,
        max_ack_pending: this.maxAckPending,
      });
      logger.info("Created SIGNALS consumer", { name: this.name });
    }

    this.running = true;
    this.loop = this.runLoop();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.loop) {
      try {
        await this.loop;
      } catch {
        // Loop errors already logged
      }
      this.loop = null;
    }
  }

  /**
   * Stop the loop AND delete the durable consumer entry from the broker.
   * Used by tests for clean isolation; production keeps the durable across
   * daemon restarts so unacked messages aren't lost.
   */
  async destroy(): Promise<void> {
    await this.stop();
    try {
      const jsm = await this.nc.jetstreamManager();
      await jsm.consumers.delete(STREAM_NAME, this.name);
    } catch {
      // Already gone
    }
  }

  private async runLoop(): Promise<void> {
    const consumer = await this.nc.jetstream().consumers.get(STREAM_NAME, this.name);

    while (this.running) {
      let batch: Awaited<ReturnType<typeof consumer.fetch>>;
      try {
        batch = await consumer.fetch({ max_messages: this.batchSize, expires: this.expiresMs });
      } catch (err) {
        logger.warn("SIGNALS consumer fetch failed", { error: stringifyError(err) });
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }

      for await (const msg of batch) {
        await this.handleMessage(msg);
      }
    }
  }

  private async handleMessage(msg: JsMsg): Promise<void> {
    let envelope: SignalEnvelope;
    try {
      envelope = SignalEnvelopeSchema.parse(JSON.parse(dec.decode(msg.data)));
    } catch (err) {
      logger.warn("Discarding malformed signal envelope", {
        seq: msg.seq,
        subject: msg.subject,
        error: stringifyError(err),
      });
      msg.term();
      return;
    }

    // Forward onward (production wiring: publishCascade onto the
    // CASCADES stream) and ack. Cascade execution is decoupled — the
    // CascadeConsumer applies the per-signal concurrency policy and
    // runs the cascade as a background Promise.
    try {
      await this.dispatch(envelope);
      msg.ack();
    } catch (err) {
      const info = msg.info;
      if (info.deliveryCount >= this.maxDeliver) {
        logger.error("Signal forward dead-lettered after max deliveries", {
          subject: msg.subject,
          seq: msg.seq,
          deliveryCount: info.deliveryCount,
          envelope,
          error: stringifyError(err),
        });
        msg.term();
        return;
      }
      logger.warn("Signal forward failed; will redeliver", {
        subject: msg.subject,
        seq: msg.seq,
        deliveryCount: info.deliveryCount,
        error: stringifyError(err),
      });
      msg.nak();
    }
  }
}

/**
 * Subscribe to a correlationId's response subject and resolve with the
 * first reply (or reject on timeout). Caller must subscribe BEFORE
 * publishing the request envelope, otherwise a fast response could be
 * missed.
 */
export async function awaitSignalCompletion(
  nc: NatsConnection,
  correlationId: string,
  timeoutMs = 30_000,
): Promise<SignalResponse> {
  const subject = signalResponseSubject(correlationId);
  const sub = nc.subscribe(subject, { max: 1 });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      sub.unsubscribe();
      reject(new Error(`awaitSignalCompletion: timeout after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    const iter = sub[Symbol.asyncIterator]();
    const winner = await Promise.race([iter.next(), timeout]);
    if (winner.done || !winner.value) {
      throw new Error("awaitSignalCompletion: subscription closed without a response");
    }
    return SignalResponseSchema.parse(JSON.parse(dec.decode(winner.value.data)));
  } finally {
    if (timer) clearTimeout(timer);
    try {
      sub.unsubscribe();
    } catch {
      // Already gone
    }
  }
}
