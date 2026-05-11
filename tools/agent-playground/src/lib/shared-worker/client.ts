/**
 * Page-side client for the SharedWorker event firehose.
 *
 * Each browsing context (tab) calls `getStreamClient()` which lazily
 * opens the SharedWorker, then calls one of the five typed `subscribeTo*`
 * wrappers. Each wrapper returns an `AsyncIterable<T>` whose iterator
 * surrenders frames the worker decides match the channel's filter.
 * Cancellation is signal-driven: callers pass an `AbortSignal` (often
 * tied to a Svelte `$effect` cleanup) and the iterator returns cleanly.
 *
 * Why async iterables: TanStack's `streamedQuery` accepts them
 * directly, and they compose with `for await` for the imperative
 * subscribers (cascade banner). The wrappers are framework-agnostic.
 *
 * Replay-then-subscribe: the wrappers that need a starting snapshot
 * (`subscribeToCascadeEvents`) issue the REST replay before yielding
 * any worker frames. Callers never see the seam.
 *
 * @module
 */

import {
  ElicitationSchema,
  type Elicitation,
} from "@atlas/core/elicitations/model";
import { z } from "zod";
import type { ClientMessage, SubscribeParams, WorkerMessage } from "./protocol.ts";
import { sessionEventStream } from "../utils/session-event-stream.ts";
import type {
  EphemeralChunk,
  SessionStreamEvent,
} from "@atlas/core/session/session-events";

/**
 * The instance-event union the cascade banner cares about. Replicated
 * here from the daemon-side schema because the firehose payload is
 * `unknown` at the worker boundary — Zod parses at the consumer edge.
 */
const SaturatedSchema = z.object({
  type: z.literal("cascade.queue_saturated"),
  at: z.string(),
  inFlight: z.number(),
  cap: z.number(),
  backlog: z.number(),
  deepestSignal: z.string().optional(),
});
const DrainedSchema = z.object({
  type: z.literal("cascade.queue_drained"),
  at: z.string(),
  inFlight: z.number(),
  cap: z.number(),
});
const TimeoutSchema = z.object({
  type: z.literal("cascade.queue_timeout"),
  at: z.string(),
  workspaceId: z.string(),
  signalId: z.string(),
  queuedMs: z.number(),
  correlationId: z.string().optional(),
});
const ReplacedSchema = z.object({
  type: z.literal("cascade.replaced"),
  at: z.string(),
  workspaceId: z.string(),
  signalId: z.string(),
  cancelledSessionId: z.string(),
  newSessionId: z.string(),
});
export const InstanceCascadeEventSchema = z.discriminatedUnion("type", [
  SaturatedSchema,
  DrainedSchema,
  TimeoutSchema,
  ReplacedSchema,
]);
export type InstanceCascadeEvent = z.infer<typeof InstanceCascadeEventSchema>;

const CascadeReplayResponseSchema = z.object({ events: z.array(InstanceCascadeEventSchema) });

/**
 * How many recent cascade events the banner replays on mount. Older
 * transitions silently drop — fine for the banner's "current state"
 * model since a saturated/drained pair more than this many entries
 * back has long since been superseded.
 */
const CASCADE_REPLAY_LIMIT = 50;

/**
 * Shape published on `events.<ws>.schedule.missed`. Matches the schema
 * the /schedules page parses against the replay endpoint — including
 * the optional KV-joined `status` / `pending` / `actionedAt` fields
 * that only the replay path stamps. The live SSE path leaves them
 * undefined; consumers backfill (manual → pending, auto-policies →
 * status:"auto").
 */
export const ScheduleMissedEventSchema = z.object({
  type: z.literal("schedule.missed"),
  workspaceId: z.string(),
  signalId: z.string(),
  policy: z.enum(["coalesce", "catchup", "manual"]),
  missedCount: z.number(),
  firstMissedAt: z.string(),
  lastMissedAt: z.string(),
  scheduledAt: z.string(),
  firedAt: z.string(),
  schedule: z.string(),
  timezone: z.string(),
  status: z.enum(["pending", "fired", "dismissed", "auto"]).optional(),
  pending: z.boolean().optional(),
  actionedAt: z.string().optional(),
  id: z.string().optional(),
});
export type ScheduleMissedEvent = z.infer<typeof ScheduleMissedEventSchema>;

// ---------------------------------------------------------------------------
// Client singleton
// ---------------------------------------------------------------------------

interface PendingSubscription {
  push(payload: unknown): void;
  fail(error: string): void;
  close(): void;
}

interface StreamClient {
  subscribe(params: SubscribeParams, handler: PendingSubscription): string;
  unsubscribe(id: string): void;
}

let cachedClient: StreamClient | undefined;

/**
 * Open (or return the cached) SharedWorker connection. Idempotent
 * within a single tab — multiple wrapper calls share one MessagePort.
 *
 * Throws synchronously if `SharedWorker` isn't available; callers in
 * SSR / non-browser contexts must guard with `browser` before invoking.
 */
export function getStreamClient(): StreamClient {
  if (cachedClient) return cachedClient;

  if (typeof SharedWorker === "undefined") {
    throw new Error("SharedWorker not available in this environment");
  }

  const worker = new SharedWorker(new URL("./worker.ts", import.meta.url), {
    type: "module",
    name: "friday-me-stream",
  });

  const handlers = new Map<string, PendingSubscription>();
  let nextId = 0;

  worker.port.addEventListener("message", (event: MessageEvent<WorkerMessage>) => {
    const msg = event.data;
    if (msg.type === "frame") {
      const h = handlers.get(msg.subscriptionId);
      h?.push(msg.payload);
    } else if (msg.type === "error") {
      const h = handlers.get(msg.subscriptionId);
      h?.fail(msg.error);
    }
    // `upstream` state messages are advisory; wrappers don't surface
    // them today (the per-channel error contract is "iterator throws").
  });
  worker.port.start();

  const client: StreamClient = {
    subscribe(params, handler) {
      const id = `sub-${++nextId}-${Date.now().toString(36)}`;
      handlers.set(id, handler);
      const msg: ClientMessage = { type: "subscribe", subscriptionId: id, params };
      worker.port.postMessage(msg);
      return id;
    },
    unsubscribe(id) {
      handlers.delete(id);
      const msg: ClientMessage = { type: "unsubscribe", subscriptionId: id };
      worker.port.postMessage(msg);
    },
  };

  cachedClient = client;
  return client;
}

// ---------------------------------------------------------------------------
// Subscription primitive: turn worker push into async iterable
// ---------------------------------------------------------------------------

interface SubscribeOpts {
  signal?: AbortSignal;
}

/**
 * Bridge the worker's push-based delivery onto a pull-based async
 * iterable. Buffers in-order if the consumer hasn't `await`ed the next
 * value yet — common during a burst that arrives between renders.
 *
 * Backpressure isn't a concern in practice: the buffer is bounded
 * implicitly by the rate at which the daemon publishes (workspace
 * lifecycle ticks, cascade transitions, elicitation creation). Worst
 * case the consumer falls a few frames behind and catches up — no
 * frame is dropped.
 */
function subscribe<T>(
  params: SubscribeParams,
  parse: (payload: unknown) => T | undefined,
  opts: SubscribeOpts,
): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]() {
      const client = getStreamClient();
      const buffer: T[] = [];
      const waiters: Array<{
        resolve: (r: IteratorResult<T>) => void;
        reject: (e: unknown) => void;
      }> = [];
      let done = false;
      let error: unknown;

      const handler: PendingSubscription = {
        push(payload) {
          const parsed = parse(payload);
          if (parsed === undefined) return;
          const waiter = waiters.shift();
          if (waiter) waiter.resolve({ value: parsed, done: false });
          else buffer.push(parsed);
        },
        fail(message) {
          error = new Error(message);
          for (const w of waiters) w.reject(error);
          waiters.length = 0;
          done = true;
        },
        close() {
          done = true;
          for (const w of waiters) w.resolve({ value: undefined, done: true });
          waiters.length = 0;
        },
      };

      const subscriptionId = client.subscribe(params, handler);

      const onAbort = () => {
        handler.close();
        client.unsubscribe(subscriptionId);
      };
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      if (opts.signal?.aborted) onAbort();

      return {
        next(): Promise<IteratorResult<T>> {
          if (error) return Promise.reject(error);
          if (buffer.length > 0) {
            return Promise.resolve({ value: buffer.shift() as T, done: false });
          }
          if (done) return Promise.resolve({ value: undefined, done: true });
          return new Promise((resolve, reject) => {
            waiters.push({ resolve, reject });
          });
        },
        return(): Promise<IteratorResult<T>> {
          opts.signal?.removeEventListener("abort", onAbort);
          handler.close();
          client.unsubscribe(subscriptionId);
          return Promise.resolve({ value: undefined, done: true });
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Typed wrappers
// ---------------------------------------------------------------------------

/**
 * Cascade-banner feed. Replay-then-subscribe: yields any saturated/
 * drained transitions from the recent past first, then live transitions
 * as they happen. The consumer reduces the stream into the
 * `saturatedState | null` model already used by the banner component.
 */
export async function* subscribeToCascadeEvents(
  opts: SubscribeOpts = {},
): AsyncGenerator<InstanceCascadeEvent> {
  // Replay first so a banner state existing before the page loaded is
  // restored on mount. The daemon's replay endpoint returns the most
  // recent first; reverse so the consumer sees them in time order.
  try {
    const res = await fetch(
      `/api/daemon/api/instance/events?type=cascade.&limit=${CASCADE_REPLAY_LIMIT}`,
    );
    if (res.ok) {
      const json: unknown = await res.json();
      const parsed = CascadeReplayResponseSchema.safeParse(json);
      if (parsed.success) {
        for (const event of [...parsed.data.events].reverse()) {
          if (opts.signal?.aborted) return;
          yield event;
        }
      }
    }
  } catch {
    // Replay failed — proceed with live stream anyway. Banner will
    // catch up on next transition.
  }

  if (opts.signal?.aborted) return;

  const live = subscribe<InstanceCascadeEvent>(
    { channel: "cascade" },
    (payload) => InstanceCascadeEventSchema.safeParse(payload).data,
    opts,
  );
  for await (const event of live) yield event;
}

/**
 * Every elicitation the user has access to, across every workspace.
 * The daemon already does the workspace-scope authz filter — "global"
 * here means "every accessible workspace".
 */
export function subscribeToGlobalElicitations(opts: SubscribeOpts = {}): AsyncIterable<Elicitation> {
  return subscribe(
    { channel: "global-elicitations" },
    (payload) => ElicitationSchema.safeParse(payload).data,
    opts,
  );
}

/** Elicitations for a single workspace. */
export function subscribeToWorkspaceElicitations(
  workspaceId: string,
  opts: SubscribeOpts = {},
): AsyncIterable<Elicitation> {
  return subscribe(
    { channel: "workspace-elicitations", workspaceId },
    (payload) => ElicitationSchema.safeParse(payload).data,
    opts,
  );
}

/** Schedule lifecycle events (`events.<ws>.schedule.*`). */
export function subscribeToScheduleEvents(
  opts: SubscribeOpts = {},
): AsyncIterable<ScheduleMissedEvent> {
  return subscribe(
    { channel: "schedule-events" },
    (payload) => ScheduleMissedEventSchema.safeParse(payload).data,
    opts,
  );
}

/**
 * Session events for one session id. Falls back to the legacy
 * `/api/sessions/:id/stream` SSE today — sessions go through a
 * JetStream pull consumer with a different shape than the user
 * firehose. The wrapper hides the transport so consumers don't need
 * to know.
 *
 * When the firehose absorbs `sessions.<sid>.events` (Phase 5+), this
 * wrapper switches over without consumer changes.
 */
export function subscribeToSessionEvents(
  sessionId: string,
  opts: SubscribeOpts = {},
): AsyncIterable<SessionStreamEvent | EphemeralChunk> {
  return sessionEventStream(sessionId, opts);
}
