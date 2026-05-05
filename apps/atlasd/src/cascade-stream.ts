/**
 * Cascade execution decoupled from signal delivery.
 *
 * Two-stream pipeline:
 *
 *   cron / HTTP / cross-cascade emit
 *      │ publishSignal()
 *      ▼
 *   SIGNALS stream  (delivery durability)
 *      │
 *      ▼ thin forwarder, ack
 *   SignalConsumer → publishCascade()
 *      │
 *      ▼
 *   CASCADES stream  (dispatch buffer)
 *      │
 *      ▼ applies concurrencyPolicy, kicks off cascade as background
 *        Promise (NOT awaited from the loop), acks on policy decision
 *   CascadeConsumer
 *      │
 *      ▼
 *   triggerWorkspaceSignal → runtime.processSignal (FSM engine)
 *
 * Why this exists: prior to the split, `SignalConsumer.handleMessage`
 * awaited the entire FSM cascade before acking. A 3-min cascade on
 * workspace A blocked every other workspace's signal — including
 * trivial no-op cron jobs. Splitting delivery from execution lets
 * one consumer drain SIGNALS quickly while a separate consumer
 * runs cascades concurrently.
 *
 * Crash semantics: max_deliver=1 on CASCADES, ack on policy decision.
 * If the daemon crashes mid-cascade, the message is gone and the
 * cascade does NOT replay. The session is left in active state and
 * gets flipped to "interrupted" by the existing
 * `markInterruptedSessions` sweep on next daemon startup. This is a
 * deliberate behaviour change from pre-cascade-split (which would
 * redeliver the same SIGNALS msg up to 5×): replays of crashed
 * cascades are likely to fail again the same way and burn ack budget.
 * Operators that need every-tick semantics should rely on the cron
 * `onMissed: catchup` policy plus the in-runtime session lifecycle —
 * the queue layer no longer hides crashes behind retries.
 */

import type { AtlasUIMessageChunk } from "@atlas/agent-sdk";
import type { ConcurrencyPolicy } from "@atlas/config";
import { logger } from "@atlas/logger";
import { stringifyError } from "@atlas/utils";
import {
  AckPolicy,
  DeliverPolicy,
  type JsMsg,
  type NatsConnection,
  RetentionPolicy,
  StorageType,
} from "nats";
import {
  type CascadeQueueDrainedEvent,
  type CascadeQueueSaturatedEvent,
  type CascadeQueueTimeoutEvent,
  type CascadeReplacedEvent,
  publishInstanceEvent,
} from "./instance-events.ts";
import {
  type SignalEnvelope,
  SignalEnvelopeSchema,
  type SignalResponse,
  signalResponseSubject,
  signalStreamSubject,
} from "./signal-stream.ts";

// `ConcurrencyPolicy` (`skip` | `queue` | `concurrent` | `replace`) is
// the workspace-config schema type — imported from `@atlas/config` and
// used locally below. Callsites should also import directly from
// `@atlas/config` (re-exporting would push the discriminated-union
// inference through this module and cause deep-type explosions
// downstream).

const STREAM_NAME = "CASCADES";
const DEFAULT_MAX_AGE_NS = 60 * 60 * 1_000_000_000; // 1h
const DEFAULT_DUPLICATE_WINDOW_NS = 5 * 60 * 1_000_000_000; // 5min
const DEFAULT_QUEUE_TIMEOUT_MS = 5 * 60 * 1000; // 5min
const DEFAULT_MAX_ACK_PENDING = 32;

const enc = new TextEncoder();
const dec = new TextDecoder();

export interface CascadesStreamLimits {
  maxAgeNs?: number | bigint;
  duplicateWindowNs?: number | bigint;
}

const toNumber = (v: number | bigint | undefined, fallback: number): number => {
  if (v === undefined) return fallback;
  return typeof v === "bigint" ? Number(v) : v;
};

export function cascadeSubject(workspaceId: string, signalId: string): string {
  // Same sanitization rules as signal subjects — see SAFE_TOKEN_RE in signal-stream.ts.
  const safe = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, "_");
  return `cascades.${safe(workspaceId)}.${safe(signalId)}`;
}

export async function ensureCascadesStream(
  nc: NatsConnection,
  limits: CascadesStreamLimits = {},
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
    subjects: ["cascades.*.*"],
    retention: RetentionPolicy.Workqueue,
    storage: StorageType.File,
    max_age: toNumber(limits.maxAgeNs, DEFAULT_MAX_AGE_NS),
    duplicate_window: toNumber(limits.duplicateWindowNs, DEFAULT_DUPLICATE_WINDOW_NS),
  });
  logger.info("Created CASCADES JetStream stream");
}

/**
 * Publish a cascade envelope. Same shape as SignalEnvelope — the cascade
 * runner needs all the same data the signal carried. `msgID` dedupes
 * within `duplicate_window`; the natural id is `(workspaceId, signalId,
 * publishedAt)` which the signal forwarder reuses verbatim from the
 * signal envelope so a redelivered SIGNALS msg can't double-dispatch
 * the same cascade.
 */
export async function publishCascade(
  nc: NatsConnection,
  envelope: SignalEnvelope,
): Promise<{ seq: number }> {
  const subject = cascadeSubject(envelope.workspaceId, envelope.signalId);
  const msgID = `${envelope.workspaceId}/${envelope.signalId}/${envelope.publishedAt}`;
  const ack = await nc
    .jetstream()
    .publish(subject, enc.encode(JSON.stringify(envelope)), { msgID });
  return { seq: ack.seq };
}

/**
 * Dispatcher injected by the daemon — runs the FSM cascade for one
 * envelope. Mirrors the existing `triggerWorkspaceSignal` shape:
 * returns the session id + final FSM document outputs on success;
 * throws `SessionFailedError` for domain-level failures (LLM error,
 * tool error) and other Errors for infra-level failures.
 *
 * `abortSignal` is wired to the runtime via `triggerSignalWithSession`'s
 * existing 6th arg — the `replace` policy uses it to cancel an
 * in-flight cascade in favour of a newer envelope.
 */
export type CascadeDispatcher = (
  envelope: SignalEnvelope,
  ctx: { onStreamEvent?: (chunk: AtlasUIMessageChunk) => void; abortSignal: AbortSignal },
) => Promise<{
  sessionId: string;
  output: Array<{ id: string; type: string; data: Record<string, unknown> }>;
}>;

/**
 * Read the per-signal concurrency policy from workspace.yml. Injected
 * so the consumer doesn't depend on WorkspaceManager directly. Falls
 * back to "skip" (the default) on lookup miss.
 */
export type ConcurrencyPolicyResolver = (
  workspaceId: string,
  signalId: string,
) => Promise<ConcurrencyPolicy>;

export interface CascadeConsumerOptions {
  name?: string;
  expiresMs?: number;
  batchSize?: number;
  maxAckPending?: number;
  /** ms an envelope can wait in CASCADES before being terminated as queue-timeout. */
  queueTimeoutMs?: number;
}

interface InFlightCascade {
  controller: AbortController;
  /** Resolves when the cascade settles. */
  done: Promise<void>;
  startedAt: number;
  sessionId?: string;
}

/**
 * Pull-based consumer that drains CASCADES, applies the per-signal
 * concurrency policy, and kicks off each cascade as a background
 * Promise (NOT awaited from the runLoop, so a slow cascade does not
 * stall delivery of the next envelope).
 *
 * Concurrency knobs:
 *  - max_ack_pending caps total in-flight cascades (broker-level).
 *  - per-(workspace,signal) registry enforces the policy.
 *  - INSTANCE_EVENTS surface saturation / replace / queue-timeout
 *    transitions so UIs can render system state without polling.
 */
export class CascadeConsumer {
  private running = false;
  private loop: Promise<void> | null = null;
  private readonly name: string;
  private readonly expiresMs: number;
  private readonly batchSize: number;
  private readonly maxDeliver = 1; // cascades fail-fast at the queue level; surface as failed sessions
  private readonly maxAckPending: number;
  private readonly ackWaitNs: number;
  private readonly queueTimeoutMs: number;

  /**
   * In-flight cascades grouped by `${workspaceId}:${signalId}`. A Set
   * (not a single slot) so the `concurrent` policy — which legitimately
   * runs N cascades for the same key at once — doesn't have its
   * earlier entries silently overwritten on subsequent dispatches.
   * For `skip` / `queue` / `replace` the set holds at most one in
   * steady state.
   *
   * A cascade is added here as soon as `runCascade` is called, before
   * it acquires a dispatch slot. So `totalInFlight()` includes both
   * cascades currently dispatching AND cascades queued at the
   * concurrency-cap semaphore.
   */
  private readonly inFlight = new Map<string, Set<InFlightCascade>>();
  /** Tail of the queue policy chain per key. */
  private readonly queueTails = new Map<string, Promise<void>>();
  /**
   * Per-key lock for the policy-decide-and-register critical section
   * inside `handleMessage`. Without this, two messages for the same
   * `(workspaceId, signalId)` arriving in the same fetch batch would
   * race on the inFlight check — both would observe size=0, both
   * would proceed (leaking past `skip` / clobbering `replace`'s abort
   * intent / overwriting `queue`'s prevTail). The lock serializes the
   * *decision*; cascades themselves still run with the configured
   * concurrency.
   */
  private readonly policyLocks = new Map<string, Promise<void>>();
  private saturated = false;

  /**
   * Cascade-execution semaphore. Distinct from JetStream's
   * `max_ack_pending`: that bounds *delivered-but-unacked* messages
   * (essentially in-flight handleMessage calls, which are fast). This
   * one bounds in-flight cascade dispatch — the actually expensive
   * thing (LLM calls, MCP roundtrips). Without it, a burst of N acks
   * fires N concurrent cascades regardless of the configured cap.
   */
  private cascadeInFlight = 0;
  private readonly cascadeWaiters: Array<() => void> = [];

  /** Total cascades registered (running + waiting for slot). */
  private totalInFlight(): number {
    let n = 0;
    for (const set of this.inFlight.values()) n += set.size;
    return n;
  }

  /** Acquire a cascade-execution slot. Resolves when a slot is free. */
  private acquireSlot(): Promise<void> {
    if (this.cascadeInFlight < this.maxAckPending) {
      this.cascadeInFlight++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.cascadeWaiters.push(() => {
        this.cascadeInFlight++;
        resolve();
      });
    });
  }

  /** Release a cascade-execution slot. Wakes the next waiter, FIFO. */
  private releaseSlot(): void {
    this.cascadeInFlight--;
    const next = this.cascadeWaiters.shift();
    if (next) next();
  }

  /**
   * Run `fn` while holding the per-key policy lock. The lock chain
   * serializes the policy-decide-and-register window for a given
   * `(workspaceId, signalId)`; same-key handleMessages from the same
   * fetch batch run their decisions one at a time. Different keys are
   * independent. Lock entries grow monotonically — at typical
   * cardinalities (<100 distinct keys per workspace) the memory cost
   * is negligible.
   */
  private async withPolicyLock<T>(key: string, fn: () => T | Promise<T>): Promise<T> {
    const prev = this.policyLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((r) => {
      release = r;
    });
    this.policyLocks.set(
      key,
      prev.then(() => next),
    );
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  constructor(
    private readonly nc: NatsConnection,
    private readonly dispatch: CascadeDispatcher,
    private readonly resolvePolicy: ConcurrencyPolicyResolver,
    opts: CascadeConsumerOptions = {},
  ) {
    this.name = opts.name ?? "atlasd-cascades";
    this.expiresMs = Math.max(1000, opts.expiresMs ?? 10_000);
    this.batchSize = opts.batchSize ?? 16;
    this.maxAckPending = opts.maxAckPending ?? DEFAULT_MAX_ACK_PENDING;
    this.queueTimeoutMs = opts.queueTimeoutMs ?? DEFAULT_QUEUE_TIMEOUT_MS;
    // ack_wait bounds crash-recovery, NOT cascade duration. We ack on
    // the policy decision (parse → resolvePolicy → ack), all of which
    // run synchronously inside `handleMessage` and finish in
    // milliseconds. The cascade itself runs as a background Promise
    // AFTER the ack — its runtime is irrelevant to the broker.
    //
    // What ack_wait actually controls: if the daemon dies between
    // receive and ack (the small "in-flight, unacked" window), the
    // broker holds the message for ack_wait before reclaiming the
    // ack_pending slot. With ack_wait = 30min and max_ack_pending = 32,
    // a crash during peak could stall the next daemon's consumer for
    // 30 min waiting for those slots to free up. Setting it to 30s
    // bounds that recovery window. With max_deliver=1 the message
    // gets term'd on redelivery anyway — we don't lose more by
    // shortening, we just unstuck the consumer faster.
    this.ackWaitNs = 30 * 1_000_000_000;
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
        deliver_policy: DeliverPolicy.All,
        max_deliver: this.maxDeliver,
        ack_wait: this.ackWaitNs,
        max_ack_pending: this.maxAckPending,
      });
      logger.info("Created CASCADES consumer", { name: this.name });
    }
    this.running = true;
    this.loop = this.runLoop();

    // Saturated state is in-memory only, so a previous daemon that
    // crashed while saturated leaves a hanging `cascade.queue_saturated`
    // event in INSTANCE_EVENTS with no matching `drained`. UI consumers
    // walking the event log would interpret that as "still saturated".
    // Emit a synthetic drained event on every startup — current inFlight
    // is 0 by definition (we just initialised the map), so the assertion
    // is honest.
    void publishInstanceEvent(
      this.nc,
      {
        type: "cascade.queue_drained",
        at: new Date().toISOString(),
        inFlight: 0,
        cap: this.maxAckPending,
      },
      logger,
    );
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.loop) {
      try {
        await this.loop;
      } catch {
        // already logged
      }
      this.loop = null;
    }
    // Best-effort: abort every in-flight cascade so the daemon can
    // shut down without waiting on long LLM calls.
    for (const set of this.inFlight.values()) {
      for (const cascade of set) {
        cascade.controller.abort("daemon shutdown");
      }
    }
  }

  /** Test-only — drop the durable consumer entry from the broker. */
  async destroy(): Promise<void> {
    await this.stop();
    try {
      const jsm = await this.nc.jetstreamManager();
      await jsm.consumers.delete(STREAM_NAME, this.name);
    } catch {
      // already gone
    }
  }

  private async runLoop(): Promise<void> {
    const consumer = await this.nc.jetstream().consumers.get(STREAM_NAME, this.name);
    while (this.running) {
      let batch: Awaited<ReturnType<typeof consumer.fetch>>;
      try {
        batch = await consumer.fetch({ max_messages: this.batchSize, expires: this.expiresMs });
      } catch (err) {
        logger.warn("CASCADES consumer fetch failed", { error: stringifyError(err) });
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }
      for await (const msg of batch) {
        // Critical: do NOT await — the whole point is to keep delivery
        // decoupled from cascade execution. handleMessage acks and
        // forks the cascade as a background Promise.
        void this.handleMessage(msg).catch((err) => {
          logger.error("Unhandled CASCADES handleMessage error", {
            seq: msg.seq,
            subject: msg.subject,
            error: stringifyError(err),
          });
        });
      }
    }
  }

  private async handleMessage(msg: JsMsg): Promise<void> {
    let envelope: SignalEnvelope;
    try {
      envelope = SignalEnvelopeSchema.parse(JSON.parse(dec.decode(msg.data)));
    } catch (err) {
      logger.warn("Discarding malformed cascade envelope", {
        seq: msg.seq,
        subject: msg.subject,
        error: stringifyError(err),
      });
      msg.term();
      return;
    }

    // Queue-timeout check — if the envelope sat long enough that any
    // synchronous caller has already given up, term it and surface the
    // skip via INSTANCE_EVENTS (and a fail response for correlated
    // callers, though those callers have likely timed out their HTTP
    // request by now).
    const queuedMs = Date.now() - new Date(envelope.publishedAt).getTime();
    if (queuedMs > this.queueTimeoutMs) {
      const event: CascadeQueueTimeoutEvent = {
        type: "cascade.queue_timeout",
        at: new Date().toISOString(),
        workspaceId: envelope.workspaceId,
        signalId: envelope.signalId,
        queuedMs,
        ...(envelope.correlationId ? { correlationId: envelope.correlationId } : {}),
      };
      await publishInstanceEvent(this.nc, event, logger);
      if (envelope.correlationId) {
        this.publishResponse(envelope.correlationId, {
          ok: false,
          error: `queue-timeout: envelope queued ${queuedMs}ms (limit ${this.queueTimeoutMs}ms)`,
        });
      }
      msg.term();
      return;
    }

    const key = `${envelope.workspaceId}:${envelope.signalId}`;
    let policy: ConcurrencyPolicy;
    try {
      policy = await this.resolvePolicy(envelope.workspaceId, envelope.signalId);
    } catch {
      policy = "skip";
    }

    // The policy decision + register-or-skip + queueTail update have
    // to happen atomically per key. Two messages for the same
    // `(workspace, signal)` arriving in the same fetch batch would
    // otherwise race on the inFlight check and both proceed past
    // `skip`, clobber `replace`'s abort intent, or overwrite
    // `queue`'s prevTail. Different keys still decide in parallel.
    await this.withPolicyLock(key, () => {
      const existingSet = this.inFlight.get(key);
      const existingCount = existingSet?.size ?? 0;

      if (existingCount > 0 && policy === "skip") {
        logger.info("Cascade skipped — concurrency=skip and same-key cascade in flight", {
          workspaceId: envelope.workspaceId,
          signalId: envelope.signalId,
        });
        if (envelope.correlationId) {
          this.publishResponse(envelope.correlationId, {
            ok: false,
            error: "skipped-duplicate: a cascade for this signal is already running",
          });
        }
        msg.ack();
        return;
      }

      let replacedExisting: InFlightCascade[] = [];
      if (existingCount > 0 && policy === "replace" && existingSet) {
        // Singleton intent: abort EVERY in-flight cascade for this key.
        // In steady-state replace usage there's at most one, but the
        // set could carry several if the workspace was previously
        // running `concurrent` and switched to `replace`.
        replacedExisting = Array.from(existingSet);
        logger.info("Cascade replacing in-flight cascade(s) — concurrency=replace", {
          workspaceId: envelope.workspaceId,
          signalId: envelope.signalId,
          cancelledCount: replacedExisting.length,
          cancelledSessionIds: replacedExisting.map((c) => c.sessionId).filter(Boolean),
        });
        for (const cascade of replacedExisting) {
          cascade.controller.abort("replaced by newer cascade");
        }
        // Don't await — that would re-introduce head-of-line blocking.
        // The runtime's abort path settles cancelled cascades
        // independently. `cascade.replaced` events publish once the
        // new cascade has its sessionId.
      }

      if (policy === "queue") {
        // Per-key serialization. Chain onto the previous tail so
        // envelopes for the same (workspace, signal) run in arrival
        // order. ack happens after policy decision (here) — the
        // cascade result still flows through response/stream subjects
        // when the chain gets there.
        const prevTail = this.queueTails.get(key) ?? Promise.resolve();
        const next = prevTail.then(() => this.runCascade(envelope, key, []));
        this.queueTails.set(
          key,
          next.catch(() => undefined),
        );
        msg.ack();
        return;
      }

      // skip with no existing, concurrent always, or replace (we
      // already aborted existing above and are starting fresh now).
      void this.runCascade(envelope, key, replacedExisting);
      msg.ack();
    });
  }

  /**
   * Run one cascade. Registers in `inFlight`, dispatches via the
   * injected dispatcher, publishes correlated response, deregisters.
   * Errors are logged and surfaced on the response subject — they do
   * not propagate back to the consumer loop.
   */
  private runCascade(
    envelope: SignalEnvelope,
    key: string,
    replacedExisting: InFlightCascade[] = [],
  ): Promise<void> {
    const controller = new AbortController();
    const startedAt = Date.now();
    const cascade: InFlightCascade = {
      controller,
      done: Promise.resolve(), // placeholder; replaced below
      startedAt,
    };
    let set = this.inFlight.get(key);
    if (!set) {
      set = new Set();
      this.inFlight.set(key, set);
    }
    set.add(cascade);
    this.maybeEmitSaturated();

    const onStreamEvent = envelope.correlationId
      ? (chunk: AtlasUIMessageChunk) => {
          try {
            this.nc.publish(
              signalStreamSubject(envelope.correlationId as string),
              enc.encode(JSON.stringify(chunk)),
            );
          } catch (err) {
            logger.warn("Failed to forward cascade stream chunk", {
              correlationId: envelope.correlationId,
              error: stringifyError(err),
            });
          }
        }
      : undefined;

    cascade.done = (async () => {
      // Acquire a cascade-execution slot before dispatching. This is
      // the actual cap on concurrent LLM/MCP load — JetStream's
      // max_ack_pending caps fast-handleMessage delivery, not cascade
      // duration. Bursts queue at the semaphore; the registered Set
      // entry above means `totalInFlight()` reflects "queued + running"
      // for saturation accounting.
      let slotHeld = false;
      try {
        await this.acquireSlot();
        slotHeld = true;
        const result = await this.dispatch(envelope, {
          onStreamEvent,
          abortSignal: controller.signal,
        });
        cascade.sessionId = result.sessionId;
        // One `cascade.replaced` event per cancelled cascade. Steady-
        // state replace cancels at most one, but if a `concurrent`-then-
        // `replace` switch produced N, surface each cancellation.
        for (const cancelled of replacedExisting) {
          if (!cancelled.sessionId) continue;
          const ev: CascadeReplacedEvent = {
            type: "cascade.replaced",
            at: new Date().toISOString(),
            workspaceId: envelope.workspaceId,
            signalId: envelope.signalId,
            cancelledSessionId: cancelled.sessionId,
            newSessionId: result.sessionId,
          };
          await publishInstanceEvent(this.nc, ev, logger);
        }
        if (envelope.correlationId) {
          this.publishResponse(envelope.correlationId, { ok: true, result });
        }
      } catch (err) {
        const msg = stringifyError(err);
        logger.warn("Cascade dispatch failed", {
          workspaceId: envelope.workspaceId,
          signalId: envelope.signalId,
          error: msg,
        });
        if (envelope.correlationId) {
          this.publishResponse(envelope.correlationId, { ok: false, error: msg });
        }
      } finally {
        // Release the cascade-execution slot first so a queued waiter
        // can acquire promptly; deregistration happens after.
        if (slotHeld) this.releaseSlot();
        // Remove this specific cascade from the per-key set. The set is
        // keyed-but-multi-valued so concurrent dispatches don't clobber
        // each other; each cascade always finds itself by identity here
        // regardless of how many siblings are running.
        const liveSet = this.inFlight.get(key);
        if (liveSet) {
          liveSet.delete(cascade);
          if (liveSet.size === 0) this.inFlight.delete(key);
        }
        this.maybeEmitDrained();
      }
    })();

    return cascade.done;
  }

  private maybeEmitSaturated(): void {
    if (this.saturated) return;
    const total = this.totalInFlight();
    if (total <= this.maxAckPending * 0.5) return;
    this.saturated = true;
    let deepestSignal: string | undefined;
    let deepestAge = -1;
    const now = Date.now();
    // Scan every cascade across every key — concurrent dispatches mean
    // one key may hold multiple cascades, and the deepest may not be
    // the first one in the set.
    for (const [key, set] of this.inFlight.entries()) {
      for (const c of set) {
        const age = now - c.startedAt;
        if (age > deepestAge) {
          deepestAge = age;
          deepestSignal = key;
        }
      }
    }
    const event: CascadeQueueSaturatedEvent = {
      type: "cascade.queue_saturated",
      at: new Date().toISOString(),
      inFlight: total,
      cap: this.maxAckPending,
      backlog: total,
      ...(deepestSignal ? { deepestSignal } : {}),
    };
    void publishInstanceEvent(this.nc, event, logger);
  }

  private maybeEmitDrained(): void {
    if (!this.saturated) return;
    const total = this.totalInFlight();
    if (total > this.maxAckPending * 0.5) return;
    this.saturated = false;
    const event: CascadeQueueDrainedEvent = {
      type: "cascade.queue_drained",
      at: new Date().toISOString(),
      inFlight: total,
      cap: this.maxAckPending,
    };
    void publishInstanceEvent(this.nc, event, logger);
  }

  private publishResponse(correlationId: string, response: SignalResponse): void {
    try {
      this.nc.publish(signalResponseSubject(correlationId), enc.encode(JSON.stringify(response)));
    } catch (err) {
      logger.warn("Failed to publish cascade response", {
        correlationId,
        error: stringifyError(err),
      });
    }
  }

  /**
   * Instrumentation — used by daemon status API.
   *
   * - `inFlight` — registered cascades (running + waiting at the
   *   concurrency cap semaphore).
   * - `running` — currently dispatching to the runtime.
   * - `waiting` — queued behind the cap.
   * - `cap` — concurrent-cascade ceiling (FRIDAY_CASCADE_CONCURRENCY).
   */
  getStats(): {
    inFlight: number;
    running: number;
    waiting: number;
    cap: number;
    saturated: boolean;
  } {
    const total = this.totalInFlight();
    return {
      inFlight: total,
      running: this.cascadeInFlight,
      waiting: total - this.cascadeInFlight,
      cap: this.maxAckPending,
      saturated: this.saturated,
    };
  }
}
