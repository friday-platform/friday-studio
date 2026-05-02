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

import type { AtlasUIMessageChunk } from "@atlas/agent-sdk";
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
});

export type SignalEnvelope = z.infer<typeof SignalEnvelopeSchema>;

export async function ensureSignalsStream(nc: NatsConnection): Promise<void> {
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
    max_msg_size: DEFAULT_MAX_MSG_SIZE,
    max_age: DEFAULT_MAX_AGE_NS,
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
}

/**
 * Publish a signal envelope onto the SIGNALS stream. Returns the broker's
 * publish sequence (not a sessionId — sessions are assigned by the consumer
 * worker when it actually runs the cascade).
 */
export async function publishSignal(
  nc: NatsConnection,
  opts: PublishSignalOpts,
): Promise<{ seq: number }> {
  const envelope: SignalEnvelope = {
    workspaceId: opts.workspaceId,
    signalId: opts.signalId,
    payload: opts.payload,
    streamId: opts.streamId,
    sourceSessionId: opts.sourceSessionId,
    publishedAt: new Date().toISOString(),
    traceId: opts.traceId,
  };

  const h = natsHeaders();
  h.set("Friday-Schema-Version", SCHEMA_VERSION);
  if (opts.traceId) h.set("Friday-Trace-Id", opts.traceId);

  const subject = signalSubject(opts.workspaceId, opts.signalId);
  const ack = await nc
    .jetstream()
    .publish(subject, enc.encode(JSON.stringify(envelope)), { headers: h });
  return { seq: ack.seq };
}

/**
 * Callback used by SignalConsumer to dispatch a received envelope to the
 * runtime. The implementation owns sessionId allocation and the actual
 * `runtime.processSignal` call.
 */
export type SignalDispatcher = (
  envelope: SignalEnvelope,
  ctx: { onStreamEvent?: (chunk: AtlasUIMessageChunk) => void },
) => Promise<void>;

export interface SignalConsumerOptions {
  /** Logical name for the durable consumer; defaults to "atlasd-signals". */
  name?: string;
  /** How long to wait per fetch before re-issuing. */
  expiresMs?: number;
  /** Max messages per fetch. */
  batchSize?: number;
  /** Max redelivery attempts before sending to dead-letter logging. */
  maxDeliver?: number;
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
        ack_wait: 5 * 60 * 1_000_000_000, // 5 min — enough for an LLM step
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

    try {
      await this.dispatch(envelope, {});
      msg.ack();
    } catch (err) {
      const info = msg.info;
      if (info.deliveryCount >= this.maxDeliver) {
        logger.error("Signal dead-lettered after max deliveries", {
          subject: msg.subject,
          seq: msg.seq,
          deliveryCount: info.deliveryCount,
          envelope,
          error: stringifyError(err),
        });
        msg.term();
        return;
      }
      logger.warn("Signal dispatch failed; will redeliver", {
        subject: msg.subject,
        seq: msg.seq,
        deliveryCount: info.deliveryCount,
        error: stringifyError(err),
      });
      msg.nak();
    }
  }
}
