/**
 * Workspace event log — JetStream-backed append-only feed of operational
 * events scoped to individual workspaces.
 *
 * **What this is for:** capturing the things a workspace operator
 * should be able to see in retrospect — missed cron firings, paused
 * timers, signal failures — that are too noisy for general-purpose
 * logs but too important to lose. The `/schedules` UI in the
 * playground reads from this stream; future workspace jobs may
 * subscribe to `events.<wsid>.>` to react programmatically.
 *
 * **What this is NOT:** the email/Slack notification *provider* config
 * in `packages/config/src/notifications.ts`. That's outbound
 * messaging templates. This is the inbound audit feed.
 *
 * **Stream layout:**
 *   name      = `WORKSPACE_EVENTS`
 *   subjects  = `events.>` (so `events.<workspaceId>.<eventType>`)
 *   storage   = file
 *   retention = limits, max_age 30 days (operational rolling window)
 *
 * **Subject conventions:**
 *   events.<workspaceId>.schedule.missed
 *   events.<workspaceId>.schedule.paused      (future)
 *   events.<workspaceId>.signal.failed        (future)
 *
 * Workspace IDs are sanitized to subject-safe characters (`a-z A-Z 0-9
 * _ -`) at publish time to defend against unusual ID shapes.
 */

import type { Logger } from "@atlas/logger";
import { stringifyError } from "@atlas/utils";
import { type NatsConnection, RetentionPolicy, StorageType } from "nats";

const STREAM_NAME = "WORKSPACE_EVENTS";
const SUBJECT_PREFIX = "events";
const THIRTY_DAYS_NS = 30 * 24 * 60 * 60 * 1_000_000_000;
const SAFE_TOKEN_RE = /[^A-Za-z0-9_-]/g;

const enc = new TextEncoder();

export interface ScheduleMissedEvent {
  type: "schedule.missed";
  workspaceId: string;
  signalId: string;
  /** Which onMissed policy produced this event. */
  policy: "coalesce" | "catchup";
  /** Total slots collapsed. Always 1 for catchup; >= 1 for coalesce. */
  missedCount: number;
  /** ISO 8601 — earliest missed slot represented by this event. */
  firstMissedAt: string;
  /** ISO 8601 — latest missed slot. Equal to firstMissedAt for catchup. */
  lastMissedAt: string;
  /** ISO 8601 — the cron slot this fire represents. */
  scheduledAt: string;
  /** ISO 8601 — wall-clock time the make-up fire dispatched. */
  firedAt: string;
  /** Cron expression for context. */
  schedule: string;
  /** Timezone the cron expression resolves in. */
  timezone: string;
}

export type WorkspaceEvent = ScheduleMissedEvent;

/** Ensure the WORKSPACE_EVENTS stream exists with the right config. */
export async function ensureWorkspaceEventsStream(nc: NatsConnection): Promise<void> {
  const jsm = await nc.jetstreamManager();
  try {
    await jsm.streams.info(STREAM_NAME);
    return; // already there — leave it; future config drift goes through a migration
  } catch {
    await jsm.streams.add({
      name: STREAM_NAME,
      subjects: [`${SUBJECT_PREFIX}.>`],
      retention: RetentionPolicy.Limits,
      storage: StorageType.File,
      max_age: THIRTY_DAYS_NS,
    });
  }
}

function sanitizeToken(s: string): string {
  return s.replace(SAFE_TOKEN_RE, "_");
}

/** Publish a workspace event. Subject derived from `event.type`. */
export async function publishWorkspaceEvent(
  nc: NatsConnection,
  event: WorkspaceEvent,
  logger?: Logger,
): Promise<void> {
  const wsToken = sanitizeToken(event.workspaceId);
  const subject = `${SUBJECT_PREFIX}.${wsToken}.${event.type}`;
  try {
    const js = nc.jetstream();
    await js.publish(subject, enc.encode(JSON.stringify(event)));
  } catch (err) {
    // Notification publishing is best-effort; failing here must not
    // break the cron firing that triggered it. Logged at WARN so the
    // operator sees it without ERROR-level alerting.
    logger?.warn("Failed to publish workspace event", {
      subject,
      type: event.type,
      error: stringifyError(err),
    });
  }
}

const dec = new TextDecoder();

/**
 * Read the most recent workspace events, filtered by workspace id.
 *
 * Backwards walk by sequence using direct-get — same pattern as chat
 * read (`chat.ts`). At expected scale (~30d × low-frequency operational
 * events) this is sub-second; the SCAN_LIMIT caps the pathological case
 * where the stream has many other workspaces' events ahead of the
 * caller's. Switch to a server-side filtered consumer if cardinality
 * outgrows that.
 */
export async function listWorkspaceEvents(
  nc: NatsConnection,
  workspaceId: string,
  options: { limit?: number; scanLimit?: number } = {},
): Promise<WorkspaceEvent[]> {
  const limit = options.limit ?? 50;
  const scanLimit = options.scanLimit ?? 5000;
  const wsToken = sanitizeToken(workspaceId);
  const subjectPrefix = `${SUBJECT_PREFIX}.${wsToken}.`;

  const jsm = await nc.jetstreamManager();
  let info: Awaited<ReturnType<typeof jsm.streams.info>> | null = null;
  try {
    info = await jsm.streams.info(STREAM_NAME);
  } catch {
    return []; // stream not yet created — fresh install, no events
  }
  const lastSeq = Number(info.state.last_seq);
  if (lastSeq === 0) return [];
  const firstSeq = Number(info.state.first_seq);

  const events: WorkspaceEvent[] = [];
  let scanned = 0;
  for (let seq = lastSeq; seq >= firstSeq && events.length < limit && scanned < scanLimit; seq--) {
    scanned++;
    let msg: Awaited<ReturnType<typeof jsm.streams.getMessage>> | null = null;
    try {
      msg = await jsm.streams.getMessage(STREAM_NAME, { seq });
    } catch {
      // Sequence gap (purged / dedup'd) — skip.
      continue;
    }
    if (!msg || !msg.subject.startsWith(subjectPrefix)) continue;
    try {
      events.push(JSON.parse(dec.decode(msg.data)) as WorkspaceEvent);
    } catch {
      // Malformed payload — skip rather than fail the whole list.
    }
  }
  return events;
}
