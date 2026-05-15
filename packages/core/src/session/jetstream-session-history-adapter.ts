/**
 * JetStream-backed `SessionHistoryAdapter`.
 *
 * Replaces the on-disk JSONL files at
 * `~/.atlas/sessions-v2/<sid>/{events.jsonl, metadata.json}` with:
 *
 *   - Stream `SESSION_EVENTS`, subject `sessions.<sid>.events` —
 *     append-only event log, file storage, 90d retention.
 *   - KV bucket `SESSION_METADATA`, key `<sid>` → SessionSummary —
 *     finalized per-session summary.
 *   - KV bucket `SESSION_INFLIGHT`, key `<sid>` → marker — written
 *     on first event, deleted on save. Lets `markInterruptedSessions`
 *     enumerate sessions whose daemon died mid-flight without
 *     scanning the whole stream.
 *
 * `get()` reads the session's events back via filtered direct-get
 * (`subject_filter = sessions.<sid>.events`) and reduces them into a
 * SessionView. Stream sequence ordering matches publish order, so the
 * reducer sees events in the same order as the JSONL implementation.
 */

import { createHash } from "node:crypto";
import { createLogger } from "@atlas/logger";
import { createJetStreamKVStorage, type KVStorage } from "@atlas/storage";
import { dec, enc, isStreamNotFound, registerReconnectReset } from "jetstream";
import { AckPolicy, DeliverPolicy, type NatsConnection, RetentionPolicy, StorageType } from "nats";
import type { SessionStreamEvent, SessionSummary, SessionView } from "./session-events.ts";
import { SessionStreamEventSchema, SessionSummarySchema } from "./session-events.ts";
import type { SessionHistoryAdapter } from "./session-history-adapter.ts";
import { buildSessionView } from "./session-reducer.ts";

/**
 * Stable per-event id used as `Nats-Msg-Id` so the broker dedups
 * republishes (which happen when `save()` lands a session that
 * `appendEvent` already streamed). Hash is deterministic on event
 * content + sessionId, so the same event published twice resolves
 * to the same id and the second publish is rejected.
 */
function eventMsgId(sessionId: string, event: SessionStreamEvent): string {
  return createHash("sha256")
    .update(`${sessionId}:${JSON.stringify(event)}`)
    .digest("base64url")
    .slice(0, 32);
}

const logger = createLogger({ component: "jetstream-session-history-adapter" });

const STREAM_NAME = "SESSION_EVENTS";
const SUBJECT_PREFIX = "sessions";
const METADATA_BUCKET = "SESSION_METADATA";
const INFLIGHT_BUCKET = "SESSION_INFLIGHT";

const NINETY_DAYS_NS = 90 * 24 * 60 * 60 * 1_000_000_000;
/**
 * Default broker-side dedup window for `SESSION_EVENTS`. The default
 * `duplicate_window` (2m) was insufficient for long-running FSM jobs: past
 * 2m a re-publish of the stable-msg-id event from `save()` lands AS NEW
 * instead of being deduped. The reducer's `step:start` matcher (agentName +
 * pending) then appends a duplicate AgentBlock, and status derivation sees
 * both pending and complete simultaneously — surfacing to the user as
 * `status: "active"` post-completion.
 *
 * 24h matches the default chosen by the JetStream config module
 * (`packages/jetstream/src/config.ts`), and by the chat backend and
 * narrative store. ~Few hundred MB of extra disk on bursty workloads.
 */
const DEFAULT_DUPLICATE_WINDOW_NS = 24 * 60 * 60 * 1_000_000_000;

const SAFE_TOKEN_RE = /[^A-Za-z0-9_-]/g;
function sanitize(s: string): string {
  return s.replace(SAFE_TOKEN_RE, "_");
}

/**
 * Value stored in `SESSION_INFLIGHT[sessionId]`. workspaceId and signalId
 * were added later — historical markers may have only `startedAt`, which
 * is why both are optional on read.
 */
interface InflightMarker {
  startedAt: string;
  workspaceId?: string;
  signalId?: string;
}

export class JetStreamSessionHistoryAdapter implements SessionHistoryAdapter {
  private metadataKV: KVStorage | null = null;
  private inflightKV: KVStorage | null = null;
  private streamReady = false;

  constructor(private readonly nc: NatsConnection) {
    // N6: invalidate cached ensure-state on NATS reconnect.
    registerReconnectReset(this.nc, () => {
      this.metadataKV = null;
      this.inflightKV = null;
      this.streamReady = false;
    });
  }

  /** Lazily provision the SESSION_EVENTS stream with the right config. */
  private async ensureStream(): Promise<void> {
    if (this.streamReady) return;
    const jsm = await this.nc.jetstreamManager();
    const cfg = {
      name: STREAM_NAME,
      subjects: [`${SUBJECT_PREFIX}.>`],
      retention: RetentionPolicy.Limits,
      storage: StorageType.File,
      max_age: NINETY_DAYS_NS,
      duplicate_window: DEFAULT_DUPLICATE_WINDOW_NS,
    };
    try {
      await jsm.streams.info(STREAM_NAME);
      // Stream exists. Reconcile config for streams created before the J2
      // fix (broker default duplicate_window was 2m). `streams.update` is
      // idempotent when the config matches and harmless otherwise.
      // Typed catch: if the update itself fails for a permanent reason
      // (incompatible config field, broker rejection),
      // re-raise instead of silently falling through to `streams.add`
      // (which would fail with stream-already-exists and mask the real
      // error). Mirrors the elicitations adapter's `isStreamNotFound`
      // discrimination.
      await jsm.streams.update(STREAM_NAME, cfg);
    } catch (err) {
      if (!isStreamNotFound(err)) throw err;
      await jsm.streams.add(cfg);
    }
    this.streamReady = true;
  }

  private async getMetadataKV(): Promise<KVStorage> {
    if (!this.metadataKV) {
      this.metadataKV = await createJetStreamKVStorage(this.nc, {
        bucket: METADATA_BUCKET,
        history: 1,
      });
    }
    return this.metadataKV;
  }

  private async getInflightKV(): Promise<KVStorage> {
    if (!this.inflightKV) {
      this.inflightKV = await createJetStreamKVStorage(this.nc, {
        bucket: INFLIGHT_BUCKET,
        history: 1,
      });
    }
    return this.inflightKV;
  }

  private subject(sessionId: string): string {
    return `${SUBJECT_PREFIX}.${sanitize(sessionId)}.events`;
  }

  async appendEvent(sessionId: string, event: SessionStreamEvent): Promise<void> {
    await this.ensureStream();
    // The inflight marker exists so markInterruptedSessions() can find
    // sessions whose daemon died before save(). Only the start event
    // produces it: it's the first event by construction, and the marker is
    // immutable for a session's lifetime so re-writing on subsequent events
    // only burns KV revisions. Marker carries workspaceId + signalId so
    // external listers can filter without joining against another bucket;
    // signalId is derived from the start event itself when present.
    if (event.type === "session:start") {
      const inflight = await this.getInflightKV();
      const marker: InflightMarker = {
        startedAt: new Date().toISOString(),
        workspaceId: event.workspaceId,
        ...(event.signalId ? { signalId: event.signalId } : {}),
      };
      await inflight.set([sessionId], marker);
    }
    const js = this.nc.jetstream();
    await js.publish(this.subject(sessionId), enc.encode(JSON.stringify(event)), {
      msgID: eventMsgId(sessionId, event),
    });
  }

  async save(
    sessionId: string,
    events: SessionStreamEvent[],
    summary: SessionSummary,
  ): Promise<void> {
    await this.ensureStream();
    const js = this.nc.jetstream();
    // Idempotent backfill: republish each event with a stable
    // `Nats-Msg-Id`. The broker silently rejects duplicates within the
    // configured dedup window (24h post-J2; see DEFAULT_DUPLICATE_WINDOW_NS
    // above for why we bumped it from the 2m default), so the common
    // case where appendEvent already streamed every event becomes a
    // no-op at the stream layer. Without this, the reducer would see
    // two `step:start` events for every step on a save() that follows
    // appendEvent (pre-J2 reducer matched step:start by agentName+pending,
    // so a re-publish appended a duplicate block instead of merging —
    // verified in repro). J2 also added a reducer-side guard against the
    // same dup as defense-in-depth.
    if (events.length > 0) {
      for (const e of events) {
        await js.publish(this.subject(sessionId), enc.encode(JSON.stringify(e)), {
          msgID: eventMsgId(sessionId, e),
        });
      }
    }
    const metadata = await this.getMetadataKV();
    await metadata.set([sessionId], summary);
    const inflight = await this.getInflightKV();
    await inflight.delete([sessionId]);
  }

  /**
   * Overwrite the metadata KV entry for an already-saved session. C2's
   * detached aiSummary path calls this once `generateSessionSummary`
   * finishes so the Activity page (which reads via `listByWorkspace`) sees
   * the polished summary on next read. KV history=1 means the previous
   * value is dropped on write — desired semantics.
   */
  async updateSummary(sessionId: string, summary: SessionSummary): Promise<void> {
    const metadata = await this.getMetadataKV();
    await metadata.set([sessionId], summary);
  }

  async get(sessionId: string): Promise<SessionView | null> {
    await this.ensureStream();
    const subject = this.subject(sessionId);
    const jsm = await this.nc.jetstreamManager();

    // Spin up an ephemeral pull consumer filtered to this session's
    // subject. Cheaper than scanning the whole stream by sequence;
    // ephemeral so we don't accumulate per-session consumer entries.
    //
    // Suffix uses `crypto.randomUUID()` rather than `Date.now()` because
    // two reads of the same session can race within the same millisecond
    // (cron + HTTP). With the timestamp-based suffix the second
    // `consumers.add` threw `consumer-already-exists`, the catch
    // swallowed, and the second reader returned `null` — surfacing as a
    // session that vanished between requests (review N1).
    const consumerName = `session-read-${sanitize(sessionId)}-${crypto.randomUUID()}`;
    try {
      await jsm.consumers.add(STREAM_NAME, {
        name: consumerName,
        filter_subject: subject,
        deliver_policy: DeliverPolicy.All,
        ack_policy: AckPolicy.None,
        inactive_threshold: 5_000_000_000, // 5s — auto-clean if we crash
      });
    } catch (err) {
      logger.warn("Failed to create read-side session consumer", { sessionId, error: String(err) });
      return null;
    }

    const events: SessionStreamEvent[] = [];
    try {
      const js = this.nc.jetstream();
      const consumer = await js.consumers.get(STREAM_NAME, consumerName);
      const info = await consumer.info();
      const total = Number(info.num_pending);
      if (total === 0) return null;
      let received = 0;
      while (received < total) {
        const before = received;
        const batch = await consumer.fetch({
          max_messages: Math.min(500, total - received),
          expires: 1000,
        });
        for await (const msg of batch) {
          received++;
          try {
            const parsed = SessionStreamEventSchema.parse(JSON.parse(dec.decode(msg.data)));
            events.push(parsed);
          } catch (err) {
            logger.warn("Skipping corrupted session event", { sessionId, error: String(err) });
          }
        }
        if (received === before) {
          // Fetch timed out without delivering anything. info() saw `total`
          // pending but the consumer never produced them — typically
          // mid-read drift (events were ack'd by another reader, or the
          // consumer's filter raced a stream purge). Break instead of
          // spinning so a degraded stream doesn't wedge the read path.
          logger.warn("session-history get() stalled mid-read", {
            sessionId,
            expectedTotal: total,
            actualReceived: received,
          });
          break;
        }
      }
    } finally {
      try {
        await jsm.consumers.delete(STREAM_NAME, consumerName);
      } catch {
        // best-effort — `inactive_threshold` will clean up if this fails
      }
    }

    if (events.length === 0) return null;
    return buildSessionView(events);
  }

  async listByWorkspace(workspaceId?: string): Promise<SessionSummary[]> {
    const metadata = await this.getMetadataKV();
    const summaries: SessionSummary[] = [];
    for await (const e of metadata.list<unknown>([])) {
      const parsed = SessionSummarySchema.safeParse(e.value);
      if (!parsed.success) continue;
      if (workspaceId && parsed.data.workspaceId !== workspaceId) continue;
      summaries.push(parsed.data);
    }
    summaries.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
    return summaries;
  }

  async listInflight(
    workspaceId?: string,
  ): Promise<
    Array<{ sessionId: string; startedAt: string; workspaceId?: string; signalId?: string }>
  > {
    const inflight = await this.getInflightKV();
    const out: Array<{
      sessionId: string;
      startedAt: string;
      workspaceId?: string;
      signalId?: string;
    }> = [];
    for await (const e of inflight.list<InflightMarker>([])) {
      const last = e.key[e.key.length - 1];
      if (typeof last !== "string") continue;
      const marker = e.value;
      if (workspaceId !== undefined && marker.workspaceId !== workspaceId) continue;
      out.push({
        sessionId: last,
        startedAt: marker.startedAt,
        ...(marker.workspaceId ? { workspaceId: marker.workspaceId } : {}),
        ...(marker.signalId ? { signalId: marker.signalId } : {}),
      });
    }
    return out;
  }

  async markInterruptedSessions(): Promise<number> {
    const inflight = await this.getInflightKV();
    const metadata = await this.getMetadataKV();
    const candidates: string[] = [];
    for await (const e of inflight.list<unknown>([])) {
      const last = e.key[e.key.length - 1];
      if (typeof last === "string") candidates.push(last);
    }

    let count = 0;
    for (const sessionId of candidates) {
      // Race tolerance: skip if save() raced past us between the inflight
      // scan and now.
      const existingSummary = await metadata.get<SessionSummary>([sessionId]);
      if (existingSummary) {
        await inflight.delete([sessionId]);
        continue;
      }

      const view = await this.get(sessionId);
      if (!view) {
        // Inflight marker but no events — orphan; clean up.
        await inflight.delete([sessionId]);
        continue;
      }

      const summary: SessionSummary = {
        sessionId,
        workspaceId: view.workspaceId,
        jobName: view.jobName,
        task: view.task,
        status: "interrupted",
        startedAt: view.startedAt,
        completedAt: new Date().toISOString(),
        stepCount: view.agentBlocks.length,
        agentNames: view.agentBlocks.map((b) => b.agentName),
        error: "Daemon was killed mid-session",
      };
      await metadata.set([sessionId], summary);
      await inflight.delete([sessionId]);
      count++;
    }

    if (count > 0) {
      logger.info("Marked sessions as interrupted on startup", { count });
    }
    return count;
  }
}
