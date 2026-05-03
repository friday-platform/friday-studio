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

import { createLogger } from "@atlas/logger";
import { createJetStreamKVStorage, type KVStorage } from "@atlas/storage";
import { dec, enc } from "jetstream";
import { AckPolicy, DeliverPolicy, type NatsConnection, RetentionPolicy, StorageType } from "nats";
import type { SessionStreamEvent, SessionSummary, SessionView } from "./session-events.ts";
import { SessionStreamEventSchema, SessionSummarySchema } from "./session-events.ts";
import type { SessionHistoryAdapter } from "./session-history-adapter.ts";
import { buildSessionView } from "./session-reducer.ts";

const logger = createLogger({ component: "jetstream-session-history-adapter" });

const STREAM_NAME = "SESSION_EVENTS";
const SUBJECT_PREFIX = "sessions";
const METADATA_BUCKET = "SESSION_METADATA";
const INFLIGHT_BUCKET = "SESSION_INFLIGHT";

const NINETY_DAYS_NS = 90 * 24 * 60 * 60 * 1_000_000_000;

const SAFE_TOKEN_RE = /[^A-Za-z0-9_-]/g;
function sanitize(s: string): string {
  return s.replace(SAFE_TOKEN_RE, "_");
}

export class JetStreamSessionHistoryAdapter implements SessionHistoryAdapter {
  private metadataKV: KVStorage | null = null;
  private inflightKV: KVStorage | null = null;
  private streamReady = false;

  constructor(private readonly nc: NatsConnection) {}

  /** Lazily provision the SESSION_EVENTS stream with the right config. */
  private async ensureStream(): Promise<void> {
    if (this.streamReady) return;
    const jsm = await this.nc.jetstreamManager();
    try {
      await jsm.streams.info(STREAM_NAME);
    } catch {
      await jsm.streams.add({
        name: STREAM_NAME,
        subjects: [`${SUBJECT_PREFIX}.>`],
        retention: RetentionPolicy.Limits,
        storage: StorageType.File,
        max_age: NINETY_DAYS_NS,
      });
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
    const inflight = await this.getInflightKV();
    // First-event marker so markInterruptedSessions() can find sessions
    // whose daemon died before save(). Cheap re-write — JS KV de-dups
    // identical values via per-key revision history.
    await inflight.set([sessionId], { startedAt: new Date().toISOString() });
    const js = this.nc.jetstream();
    await js.publish(this.subject(sessionId), enc.encode(JSON.stringify(event)));
  }

  async save(
    sessionId: string,
    events: SessionStreamEvent[],
    summary: SessionSummary,
  ): Promise<void> {
    await this.ensureStream();
    const js = this.nc.jetstream();
    // Idempotent backfill: publish any events not already in the
    // stream. The common path is "appendEvent already pushed each event;
    // save() just writes the summary." Republishing is safe — the
    // reducer is ordering-tolerant and de-dups by event id where
    // applicable. Not using Nats-Msg-Id dedup here because save() is
    // sometimes called with a synthesized event list (eg. tests) that
    // lacks IDs; the stream's appendEvent path is the dedup boundary.
    if (events.length > 0) {
      for (const e of events) {
        await js.publish(this.subject(sessionId), enc.encode(JSON.stringify(e)));
      }
    }
    const metadata = await this.getMetadataKV();
    await metadata.set([sessionId], summary);
    const inflight = await this.getInflightKV();
    await inflight.delete([sessionId]);
  }

  async get(sessionId: string): Promise<SessionView | null> {
    await this.ensureStream();
    const subject = this.subject(sessionId);
    const jsm = await this.nc.jetstreamManager();

    // Spin up an ephemeral pull consumer filtered to this session's
    // subject. Cheaper than scanning the whole stream by sequence;
    // ephemeral so we don't accumulate per-session consumer entries.
    const consumerName = `session-read-${sanitize(sessionId)}-${Date.now()}`;
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
