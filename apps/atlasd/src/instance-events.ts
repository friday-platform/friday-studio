/**
 * Instance event log — JetStream-backed append-only feed of operational
 * events scoped to the daemon instance (cross-workspace).
 *
 * Companion to `workspace-events.ts`. Same publish-and-read shape; no KV
 * sidecar, since these events have no operator-action lifecycle (unlike
 * `schedule.missed` which can be fired/dismissed). Subscribers consume via
 * SSE on `/api/instance/events?stream=true` — no polling.
 *
 * **Stream layout:**
 *   name      = `INSTANCE_EVENTS`
 *   subjects  = `instance.>` (so `instance.<eventType>`)
 *   storage   = file
 *   retention = limits, max_age 7 days (operational rolling window)
 *
 * **Subject conventions:**
 *   instance.cascade.queue_saturated
 *   instance.cascade.queue_drained
 *   instance.cascade.queue_timeout
 *   instance.cascade.replaced
 *
 * Schema is deliberately open for future `instance.daemon.*`,
 * `instance.health.*`, etc. without a stream split.
 */

import type { Logger } from "@atlas/logger";
import { stringifyError } from "@atlas/utils";
import { type NatsConnection, RetentionPolicy, StorageType } from "nats";

const STREAM_NAME = "INSTANCE_EVENTS";
const SUBJECT_PREFIX = "instance";
const SEVEN_DAYS_NS = 7 * 24 * 60 * 60 * 1_000_000_000;

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Cascade backlog crossed `>0.5 * cap` and stayed elevated. */
export interface CascadeQueueSaturatedEvent {
  type: "cascade.queue_saturated";
  /** ISO 8601. */
  at: string;
  inFlight: number;
  cap: number;
  backlog: number;
  /** `<workspaceId>:<signalId>` of the most-backed-up key, if any. */
  deepestSignal?: string;
}

/** Cascade backlog fell back below `0.5 * cap`. Mirrors `queue_saturated`. */
export interface CascadeQueueDrainedEvent {
  type: "cascade.queue_drained";
  at: string;
  inFlight: number;
  cap: number;
}

/**
 * Envelope sat in CASCADES > `FRIDAY_CASCADE_QUEUE_TIMEOUT` (default 5min)
 * before the consumer picked it up. The consumer terms the message and
 * publishes a fail response on `signals.responses.<correlationId>` if
 * the envelope was correlated.
 */
export interface CascadeQueueTimeoutEvent {
  type: "cascade.queue_timeout";
  at: string;
  workspaceId: string;
  signalId: string;
  queuedMs: number;
  correlationId?: string;
}

/**
 * `concurrency: replace` policy aborted an in-flight cascade in favour
 * of a newer envelope. Both session ids are surfaced so operators can
 * trace the swap in `/api/sessions`.
 */
export interface CascadeReplacedEvent {
  type: "cascade.replaced";
  at: string;
  workspaceId: string;
  signalId: string;
  cancelledSessionId: string;
  newSessionId: string;
}

export type InstanceEvent =
  | CascadeQueueSaturatedEvent
  | CascadeQueueDrainedEvent
  | CascadeQueueTimeoutEvent
  | CascadeReplacedEvent;

/** Ensure the INSTANCE_EVENTS stream exists with the right config. */
export async function ensureInstanceEventsStream(nc: NatsConnection): Promise<void> {
  const jsm = await nc.jetstreamManager();
  try {
    await jsm.streams.info(STREAM_NAME);
  } catch {
    await jsm.streams.add({
      name: STREAM_NAME,
      subjects: [`${SUBJECT_PREFIX}.>`],
      retention: RetentionPolicy.Limits,
      storage: StorageType.File,
      max_age: SEVEN_DAYS_NS,
      // `allow_direct` is intentionally NOT set here — defaults to false,
      // which routes `streams.getMessage` calls to the leader and gives
      // us read-your-writes for the replay endpoint
      // (`/api/instance/events?since=...`). If a future op enables
      // direct-get on replicas to scale read throughput, the replay path
      // will lose read-your-writes and a recently-published event may
      // not appear immediately on a reload-after-disconnect.
    });
  }
}

/** Publish an instance event. Subject derived from `event.type`. */
export async function publishInstanceEvent(
  nc: NatsConnection,
  event: InstanceEvent,
  logger?: Logger,
): Promise<void> {
  const subject = `${SUBJECT_PREFIX}.${event.type}`;
  try {
    const js = nc.jetstream();
    await js.publish(subject, enc.encode(JSON.stringify(event)));
  } catch (err) {
    logger?.warn("Failed to publish instance event", {
      subject,
      type: event.type,
      error: stringifyError(err),
    });
  }
}

/**
 * Read the most recent instance events, optionally filtered by event type
 * subject (e.g. `cascade.queue_saturated` or `cascade.`). Backwards walk by
 * sequence using direct-get — same pattern as `workspace-events.ts`. Drives
 * the replay path on `/api/instance/events?since=...`.
 */
export async function listInstanceEvents(
  nc: NatsConnection,
  options: { limit?: number; scanLimit?: number; typeFilter?: string } = {},
): Promise<InstanceEvent[]> {
  const limit = options.limit ?? 100;
  const scanLimit = options.scanLimit ?? 5000;
  const subjectFilter = options.typeFilter
    ? `${SUBJECT_PREFIX}.${options.typeFilter}`
    : `${SUBJECT_PREFIX}.`;

  const jsm = await nc.jetstreamManager();
  let info: Awaited<ReturnType<typeof jsm.streams.info>> | null = null;
  try {
    info = await jsm.streams.info(STREAM_NAME);
  } catch {
    return [];
  }
  const lastSeq = Number(info.state.last_seq);
  if (lastSeq === 0) return [];
  const firstSeq = Number(info.state.first_seq);

  const events: InstanceEvent[] = [];
  let scanned = 0;
  for (let seq = lastSeq; seq >= firstSeq && events.length < limit && scanned < scanLimit; seq--) {
    scanned++;
    let msg: Awaited<ReturnType<typeof jsm.streams.getMessage>> | null = null;
    try {
      msg = await jsm.streams.getMessage(STREAM_NAME, { seq });
    } catch {
      continue;
    }
    if (!msg || !msg.subject.startsWith(subjectFilter)) continue;
    try {
      events.push(JSON.parse(dec.decode(msg.data)) as InstanceEvent);
    } catch {
      // Malformed payload — skip rather than fail the whole list.
    }
  }
  return events;
}
