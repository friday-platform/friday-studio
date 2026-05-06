/**
 * JetStream-backed elicitation storage.
 *
 * Two surfaces:
 *
 *   - **Envelopes** → JetStream stream `ELICITATIONS`. Subjects:
 *     `elicitations.<workspaceId>.<sessionId>.<elicitationId>`. Each
 *     elicitation publishes one envelope on create, then re-publishes
 *     on every state transition (answer / decline / expire) so SSE
 *     subscribers see the latest shape without round-tripping the KV.
 *     Stream is `Limits` retention, file-backed, with a per-message
 *     `Nats-TTL` header (default 1 hour, derived from `expiresAt`).
 *   - **Status** → JetStream KV bucket `ELICITATION_STATUS`, keyed by
 *     `<elicitationId>`. Holds the latest full envelope so `get(id)` is
 *     a single KV lookup (no stream scan). The stream is the durable
 *     audit trail; the KV is the index.
 *
 * **Why both:** the runtime suspend/resume path (later phase) needs
 * O(1) status reads to wake a paused FSM. SSE subscribers get the
 * stream for replay. List endpoints walk the KV for cardinality
 * reasons (the stream is intentionally short-lived per message).
 *
 * **Why no atomic across stream + KV:** same constraint as artifacts —
 * we publish the envelope first, then write the KV. A failed KV write
 * after a successful publish leaves an entry only the stream knows
 * about; that's fine for the audit trail and the next status update
 * will re-write the KV. A failed publish before the KV write means
 * nothing happened — the caller retries.
 */

import { createLogger } from "@atlas/logger";
import { fail, type Result, stringifyError, success } from "@atlas/utils";
import { dec, enc, isStreamNotFound } from "jetstream";
import {
  type KV,
  type NatsConnection,
  headers as natsHeaders,
  RetentionPolicy,
  StorageType,
} from "nats";
import {
  type CreateElicitationInput,
  type Elicitation,
  type ElicitationAnswer,
  ElicitationSchema,
  type ElicitationStatus,
} from "./model.ts";
import type { ElicitationStorageAdapter } from "./types.ts";

const logger = createLogger({ component: "jetstream-elicitation-storage" });

const STREAM_NAME = "ELICITATIONS";
const SUBJECT_PREFIX = "elicitations";
const KV_BUCKET = "ELICITATION_STATUS";
const HISTORY = 5;

/** Subjects allow only `[A-Za-z0-9_-]`-ish tokens; sanitize ids defensively. */
const SAFE_TOKEN_RE = /[^A-Za-z0-9_-]/g;
function sanitize(s: string): string {
  return s.replace(SAFE_TOKEN_RE, "_");
}

function subjectFor(elicitation: Elicitation): string {
  return [
    SUBJECT_PREFIX,
    sanitize(elicitation.workspaceId),
    sanitize(elicitation.sessionId),
    sanitize(elicitation.id),
  ].join(".");
}

export class JetStreamElicitationStorageAdapter implements ElicitationStorageAdapter {
  private cachedKv: KV | null = null;
  private streamEnsured = false;

  constructor(private readonly nc: NatsConnection) {}

  private async ensureStream(): Promise<void> {
    if (this.streamEnsured) return;
    const jsm = await this.nc.jetstreamManager();
    try {
      await jsm.streams.info(STREAM_NAME);
    } catch (err) {
      if (!isStreamNotFound(err)) throw err;
      await jsm.streams.add({
        name: STREAM_NAME,
        subjects: [`${SUBJECT_PREFIX}.>`],
        retention: RetentionPolicy.Limits,
        storage: StorageType.File,
        // Coarse upper bound on retention. Per-message TTL via the
        // `Nats-TTL` header is the fine-grained mechanism (set per
        // publish below); `max_age` is the floor for servers that
        // don't honor the header yet. Seven days = enough headroom
        // for day-long jobs to outlast their elicitations and still
        // have audit trail visible in the Activity page.
        max_age: 7 * 24 * 60 * 60 * 1_000_000_000,
      });
    }
    this.streamEnsured = true;
  }

  private async kv(): Promise<KV> {
    if (this.cachedKv) return this.cachedKv;
    const js = this.nc.jetstream();
    this.cachedKv = await js.views.kv(KV_BUCKET, { history: HISTORY, storage: StorageType.File });
    return this.cachedKv;
  }

  /**
   * Publish the current envelope shape to the stream + write to KV.
   * Both happen on create AND on every transition (answer/decline) so
   * subscribers always see the latest snapshot via the stream alone.
   */
  private async writeEnvelope(elicitation: Elicitation): Promise<void> {
    await this.ensureStream();
    const subject = subjectFor(elicitation);
    const body = enc.encode(JSON.stringify(elicitation));

    // Per-message TTL: derive from expiresAt - now. Floor at 1s so the
    // server doesn't reject a zero/negative TTL.
    const ttlMs = Math.max(1000, new Date(elicitation.expiresAt).getTime() - Date.now());
    const h = natsHeaders();
    h.set("Nats-TTL", `${Math.floor(ttlMs / 1000)}s`);

    const js = this.nc.jetstream();
    await js.publish(subject, body, { headers: h });

    const kv = await this.kv();
    await kv.put(elicitation.id, enc.encode(JSON.stringify(elicitation)));
  }

  async create(input: CreateElicitationInput): Promise<Result<Elicitation, string>> {
    try {
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      const elicitation: Elicitation = { ...input, id, status: "pending", createdAt: now };
      // Validate via schema — catches malformed callers before we publish.
      const parsed = ElicitationSchema.parse(elicitation);
      await this.writeEnvelope(parsed);
      return success(parsed);
    } catch (err) {
      logger.error("Failed to create elicitation", { error: stringifyError(err) });
      return fail(stringifyError(err));
    }
  }

  async get(input: { id: string }): Promise<Result<Elicitation | null, string>> {
    try {
      const kv = await this.kv();
      const entry = await kv.get(input.id);
      if (!entry || entry.operation !== "PUT") return success(null);
      const parsed = ElicitationSchema.parse(JSON.parse(dec.decode(entry.value)));
      return success(parsed);
    } catch (err) {
      return fail(stringifyError(err));
    }
  }

  async list(input: {
    workspaceId?: string;
    sessionId?: string;
    status?: ElicitationStatus;
  }): Promise<Result<Elicitation[], string>> {
    try {
      const kv = await this.kv();
      const it = await kv.keys();
      const out: Elicitation[] = [];
      for await (const key of it) {
        const entry = await kv.get(key);
        if (!entry || entry.operation !== "PUT") continue;
        let elicitation: Elicitation;
        try {
          elicitation = ElicitationSchema.parse(JSON.parse(dec.decode(entry.value)));
        } catch (parseErr) {
          logger.warn("Skipping malformed elicitation entry", {
            key,
            error: stringifyError(parseErr),
          });
          continue;
        }
        if (input.workspaceId !== undefined && elicitation.workspaceId !== input.workspaceId)
          continue;
        if (input.sessionId !== undefined && elicitation.sessionId !== input.sessionId) continue;
        if (input.status !== undefined && elicitation.status !== input.status) {
          continue;
        }
        out.push(elicitation);
      }
      out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return success(out);
    } catch (err) {
      return fail(stringifyError(err));
    }
  }

  async answer(input: {
    id: string;
    answer: ElicitationAnswer;
  }): Promise<Result<Elicitation, string>> {
    try {
      const got = await this.get({ id: input.id });
      if (!got.ok) return got;
      if (!got.data) return fail(`Elicitation ${input.id} not found`);
      if (got.data.status !== "pending") {
        return fail(`Elicitation ${input.id} already in terminal state: ${got.data.status}`);
      }
      const next: Elicitation = { ...got.data, status: "answered", answer: input.answer };
      await this.writeEnvelope(next);
      return success(next);
    } catch (err) {
      return fail(stringifyError(err));
    }
  }

  async decline(input: { id: string; note?: string }): Promise<Result<Elicitation, string>> {
    try {
      const got = await this.get({ id: input.id });
      if (!got.ok) return got;
      if (!got.data) return fail(`Elicitation ${input.id} not found`);
      if (got.data.status !== "pending") {
        return fail(`Elicitation ${input.id} already in terminal state: ${got.data.status}`);
      }
      const next: Elicitation = {
        ...got.data,
        status: "declined",
        answer: {
          value: "declined",
          ...(input.note ? { note: input.note } : {}),
          answeredAt: new Date().toISOString(),
        },
      };
      await this.writeEnvelope(next);
      return success(next);
    } catch (err) {
      return fail(stringifyError(err));
    }
  }
}
