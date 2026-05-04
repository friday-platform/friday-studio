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
const STATE_BUCKET = "WORKSPACE_EVENT_STATE";
const SUBJECT_PREFIX = "events";
const THIRTY_DAYS_NS = 30 * 24 * 60 * 60 * 1_000_000_000;
const SAFE_TOKEN_RE = /[^A-Za-z0-9_-]/g;

const enc = new TextEncoder();

export interface ScheduleMissedEvent {
  type: "schedule.missed";
  workspaceId: string;
  signalId: string;
  /**
   * Which onMissed policy produced this event.
   * - coalesce / catchup → fired automatically; `pending` is undefined.
   * - manual → emitted but NOT fired; `pending: true` until the
   *   operator clicks "Fire now" in the UI, then a separate
   *   per-event KV state record flips it (see `eventStateRead`).
   */
  policy: "coalesce" | "catchup" | "manual";
  /** Total slots collapsed. Always 1 for catchup; >= 1 for coalesce/manual. */
  missedCount: number;
  /** ISO 8601 — earliest missed slot represented by this event. */
  firstMissedAt: string;
  /** ISO 8601 — latest missed slot. Equal to firstMissedAt for catchup. */
  lastMissedAt: string;
  /** ISO 8601 — the cron slot this fire represents. */
  scheduledAt: string;
  /**
   * ISO 8601. For coalesce/catchup: when the make-up fire dispatched.
   * For manual: when the missed slot was detected (no fire happened).
   */
  firedAt: string;
  /** Cron expression for context. */
  schedule: string;
  /** Timezone the cron expression resolves in. */
  timezone: string;
  /**
   * Operator-action lifecycle for `manual` events. Joined in at read
   * time from the EVENT_STATE KV bucket since stream entries are
   * immutable.
   *
   * - `pending`   — manual event, waiting on operator action
   * - `fired`     — manual event the operator clicked Fire now on
   * - `dismissed` — manual event the operator clicked Dismiss on
   * - `auto`      — coalesce / catchup; never had a pending state
   *                 (the daemon auto-fired). Always `auto` when
   *                 `policy !== "manual"`.
   */
  status?: "pending" | "fired" | "dismissed" | "auto";
  /**
   * Convenience boolean kept for backwards compat with earlier UI
   * builds. Equivalent to `status === "pending"`. New code should
   * read `status` directly.
   */
  pending?: boolean;
  /**
   * ISO 8601 — when the operator actioned (fired or dismissed) the
   * event. Undefined for `auto` and `pending` rows.
   */
  actionedAt?: string;
  /**
   * Stable id derived from the event's content so the UI can address
   * it for "fire now" + the KV state record can key on it. Computed
   * at read time from the stream sequence; clients should treat as
   * opaque.
   */
  id?: string;
}

export type WorkspaceEvent = ScheduleMissedEvent;

/** Ensure the WORKSPACE_EVENTS stream exists with the right config. */
export async function ensureWorkspaceEventsStream(nc: NatsConnection): Promise<void> {
  const jsm = await nc.jetstreamManager();
  try {
    await jsm.streams.info(STREAM_NAME);
  } catch {
    await jsm.streams.add({
      name: STREAM_NAME,
      subjects: [`${SUBJECT_PREFIX}.>`],
      retention: RetentionPolicy.Limits,
      storage: StorageType.File,
      max_age: THIRTY_DAYS_NS,
    });
  }
  // Sidecar KV bucket for mutable per-event state (manual events go
  // pending → fired). Stream entries are immutable; the join happens
  // at read time. history=1 is enough — only the latest state matters.
  const js = nc.jetstream();
  await js.views.kv(STATE_BUCKET, { history: 1 });
}

/**
 * Stable per-event id used to join stream entries with KV state.
 *
 * Every segment goes through `sanitizeToken` because NATS KV keys
 * only allow `[A-Za-z0-9_-./=]`. Workspace ids occasionally have
 * colons / slashes; signal ids are usually clean but not guaranteed;
 * `scheduledAt` is an ISO 8601 timestamp whose `:` and `.` chars
 * both need escaping to make it past `Bucket.validateKey`. Periods
 * lose their semantic role as segment separators here — but the
 * outer `.join(".")` separators come from a literal and aren't
 * sanitized, so the composite stays parseable.
 */
function eventStateKey(event: ScheduleMissedEvent): string {
  return composeEventStateKey(event.workspaceId, event.signalId, event.scheduledAt);
}

function composeEventStateKey(workspaceId: string, signalId: string, scheduledAt: string): string {
  return [workspaceId, signalId, scheduledAt].map(sanitizeToken).join(".");
}

interface EventStateRecord {
  status: "pending" | "fired" | "dismissed";
  /** ISO 8601 — when status flipped. */
  updatedAt: string;
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
    // Defense-in-depth dedup for manual schedule events: if a KV
    // state record already exists for this slot, the operator has
    // already seen it (pending) or acted on it (fired/dismissed).
    // Skip the stream publish — appending another entry would inflate
    // the rolled-up count on the /schedules page.
    if (event.type === "schedule.missed" && event.policy === "manual" && event.pending) {
      const existing = await readEventState(nc, eventStateKey(event));
      if (existing) return;
    }
    const js = nc.jetstream();
    await js.publish(subject, enc.encode(JSON.stringify(event)));
    // Seed the KV state record for manual events so the read path
    // sees `pending: true` until the operator fires or dismisses.
    if (event.type === "schedule.missed" && event.policy === "manual" && event.pending) {
      await writeEventState(nc, eventStateKey(event), {
        status: "pending",
        updatedAt: new Date().toISOString(),
      });
    }
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

async function writeEventState(
  nc: NatsConnection,
  key: string,
  record: EventStateRecord,
): Promise<void> {
  const js = nc.jetstream();
  const kv = await js.views.kv(STATE_BUCKET, { history: 1 });
  await kv.put(key, enc.encode(JSON.stringify(record)));
}

/** Same as writeEventState but swallows errors. Used by the read-path
 * self-heal — a failed write must not break the list response. */
async function writeEventStateBestEffort(
  nc: NatsConnection,
  key: string,
  record: EventStateRecord,
): Promise<void> {
  try {
    await writeEventState(nc, key, record);
  } catch {
    // Intentionally silent — caller continues with a transient
    // pending state in memory; next read retries the heal.
  }
}

async function readEventState(nc: NatsConnection, key: string): Promise<EventStateRecord | null> {
  try {
    const js = nc.jetstream();
    const kv = await js.views.kv(STATE_BUCKET, { history: 1 });
    const entry = await kv.get(key);
    if (!entry || entry.operation !== "PUT") return null;
    return JSON.parse(dec.decode(entry.value)) as EventStateRecord;
  } catch {
    // Invalid key or malformed payload — treat as "no state record".
    // A KV error here would otherwise cascade through readEventsBackwards
    // and 500 the whole /api/events response. Single-row degradation is
    // strictly better than full-list failure.
    return null;
  }
}

/**
 * Mark a manual `schedule.missed` event as fired. Returns false if the
 * event isn't found (or isn't pending). The HTTP fire route calls this
 * after successfully triggering the underlying signal.
 */
export async function markEventFired(
  nc: NatsConnection,
  workspaceId: string,
  signalId: string,
  scheduledAt: string,
): Promise<boolean> {
  const key = composeEventStateKey(workspaceId, signalId, scheduledAt);
  const existing = await readEventState(nc, key);
  if (!existing || existing.status !== "pending") return false;
  await writeEventState(nc, key, { status: "fired", updatedAt: new Date().toISOString() });
  return true;
}

/**
 * Bulk: walk every pending manual event for a (workspaceId,
 * signalId) pair and apply `nextStatus` to each. Used by the group
 * action endpoints (fire-once, fire-all, dismiss-all) so the
 * operator can act on N missed slots with a single click instead
 * of N round trips. Returns the list of `scheduledAt` timestamps
 * that were transitioned, so the caller can decide how many
 * underlying signals to publish.
 */
export async function markAllPendingForSignal(
  nc: NatsConnection,
  workspaceId: string,
  signalId: string,
  nextStatus: "fired" | "dismissed",
): Promise<string[]> {
  const events = await listAllWorkspaceEvents(nc);
  const now = new Date().toISOString();
  const transitioned: string[] = [];
  for (const e of events) {
    if (e.workspaceId !== workspaceId) continue;
    if (e.signalId !== signalId) continue;
    if (e.policy !== "manual" || e.status !== "pending") continue;
    const key = composeEventStateKey(workspaceId, signalId, e.scheduledAt);
    try {
      await writeEventState(nc, key, { status: nextStatus, updatedAt: now });
      transitioned.push(e.scheduledAt);
    } catch {
      // Skip individual failures — the bulk should still flip what it can.
    }
  }
  return transitioned;
}

/**
 * Mark a manual `schedule.missed` event as dismissed (operator
 * explicitly skipped). Same shape as markEventFired.
 */
export async function markEventDismissed(
  nc: NatsConnection,
  workspaceId: string,
  signalId: string,
  scheduledAt: string,
): Promise<boolean> {
  const key = composeEventStateKey(workspaceId, signalId, scheduledAt);
  const existing = await readEventState(nc, key);
  if (!existing || existing.status !== "pending") return false;
  await writeEventState(nc, key, { status: "dismissed", updatedAt: new Date().toISOString() });
  return true;
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
export function listWorkspaceEvents(
  nc: NatsConnection,
  workspaceId: string,
  options: { limit?: number; scanLimit?: number } = {},
): Promise<WorkspaceEvent[]> {
  const wsToken = sanitizeToken(workspaceId);
  return readEventsBackwards(nc, options, `${SUBJECT_PREFIX}.${wsToken}.`);
}

/**
 * Read the most recent workspace events across ALL workspaces. Drives
 * the top-level `/schedules` page in the playground. Same backwards-walk
 * pattern as the per-workspace variant; subject filter omitted.
 */
export function listAllWorkspaceEvents(
  nc: NatsConnection,
  options: { limit?: number; scanLimit?: number } = {},
): Promise<WorkspaceEvent[]> {
  return readEventsBackwards(nc, options, `${SUBJECT_PREFIX}.`);
}

async function readEventsBackwards(
  nc: NatsConnection,
  options: { limit?: number; scanLimit?: number },
  subjectPrefix: string,
): Promise<WorkspaceEvent[]> {
  const limit = options.limit ?? 50;
  const scanLimit = options.scanLimit ?? 5000;

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
    let event: WorkspaceEvent;
    try {
      event = JSON.parse(dec.decode(msg.data)) as WorkspaceEvent;
    } catch {
      // Malformed payload — skip rather than fail the whole list.
      continue;
    }
    // Stable id (used by the fire/dismiss routes + UI keying).
    event.id = eventStateKey(event);
    events.push(event);
  }

  // Resolve KV state for all manual events in parallel — the polled
  // /schedules page used to wait on N sequential round-trips here.
  type WithId = WorkspaceEvent & { id: string };
  const manualEvents = events.filter((e): e is WithId => e.policy === "manual" && !!e.id);
  const stateResults = await Promise.all(manualEvents.map((e) => readEventState(nc, e.id)));
  const stateById = new Map<string, EventStateRecord | null>();
  manualEvents.forEach((e, i) => {
    stateById.set(e.id, stateResults[i] ?? null);
  });
  const heals: Promise<void>[] = [];
  for (const event of events) {
    if (event.policy !== "manual") {
      // coalesce / catchup are always auto-fired; no pending lifecycle.
      event.status = "auto";
      continue;
    }
    const id = event.id;
    if (!id) continue; // can't happen — event.id was assigned above
    const state = stateById.get(id);
    if (state) {
      event.status = state.status;
      event.pending = state.status === "pending";
      if (state.status !== "pending") event.actionedAt = state.updatedAt;
    } else {
      // No state record — either a publish → state-write race
      // window OR a pre-fix event whose state-seed failed silently
      // when the key contained an unescaped `:`. Self-heal: write
      // a pending record now so the operator-action surface
      // (markEventFired / markEventDismissed) finds something to
      // flip when the user clicks Fire / Dismiss.
      heals.push(
        writeEventStateBestEffort(nc, id, { status: "pending", updatedAt: event.firedAt }),
      );
      event.status = "pending";
      event.pending = true;
    }
  }
  await Promise.all(heals);
  return events;
}
