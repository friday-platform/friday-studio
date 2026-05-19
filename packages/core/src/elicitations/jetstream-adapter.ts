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
import { dec, enc, isCASConflict, isStreamNotFound, registerReconnectReset } from "jetstream";
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
import type { ElicitationStorageAdapter, ExpireSweepResult } from "./types.ts";

const logger = createLogger({ component: "jetstream-elicitation-storage" });

const STREAM_NAME = "ELICITATIONS";
const SUBJECT_PREFIX = "elicitations";
const KV_BUCKET = "ELICITATION_STATUS";
const HISTORY = 5;
const TERMINAL_ANSWER_GRACE_MS = 5_000;

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

  constructor(private readonly nc: NatsConnection) {
    // N6: invalidate cached ensure-state on NATS reconnect so the first
    // post-bounce access re-provisions instead of failing with
    // stream-not-found / bucket-not-found.
    registerReconnectReset(this.nc, () => {
      this.cachedKv = null;
      this.streamEnsured = false;
    });
  }

  private async ensureStream(): Promise<void> {
    if (this.streamEnsured) return;
    const jsm = await this.nc.jetstreamManager();
    // Stream provisioning is the migration's job (see
    // `apps/atlasd/src/migrations/m_20260505_120000_elicitations_bootstrap.ts`).
    // The adapter only validates that the migration ran with the
    // current config — specifically `allow_msg_ttl: true`, without
    // which every per-message `Nats-TTL` publish below is rejected by
    // the broker (`per-message ttl is disabled`) and elicitation
    // creates silently fail.
    //
    // Why not create-or-update here: the previous version raced the
    // migration. If the adapter won (any code path touching
    // ElicitationStorage before migrations finished) it created a
    // legacy-config stream, then `streamEnsured = true` cached that
    // mistake for the process lifetime — recovery required a daemon
    // bounce. Surfacing a clear error makes the ordering invariant
    // explicit instead of papering over it.
    let info: Awaited<ReturnType<typeof jsm.streams.info>>;
    try {
      info = await jsm.streams.info(STREAM_NAME);
    } catch (err) {
      if (isStreamNotFound(err)) {
        throw new Error(
          `ELICITATIONS stream missing — run migration ` +
            `m_20260505_120000_elicitations_bootstrap before using ElicitationStorage`,
        );
      }
      throw err;
    }
    // `allow_msg_ttl` is server-side JSON only in nats.js v2.29; the
    // typed StreamConfig doesn't expose it yet. Read via cast.
    const cfg = info.config as unknown as { allow_msg_ttl?: boolean };
    if (cfg.allow_msg_ttl !== true) {
      throw new Error(
        `ELICITATIONS stream exists but allow_msg_ttl is not enabled — ` +
          `re-run migration m_20260505_120000_elicitations_bootstrap to update config`,
      );
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
   * Create-time write path: publish the pending envelope, then write KV.
   * Terminal transitions use `transitionPending` so KV CAS decides the winner
   * before any terminal stream event is published.
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
    // Stable msg-id keyed on (id, status). Retried publishes in the broker
    // dedup window collapse to a single envelope without producing duplicate
    // audit events after a network retry.
    h.set("Nats-Msg-Id", `${elicitation.id}:${elicitation.status}`);

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
      // Read-time derivation: surface `expired` immediately for past-
      // deadline pending entries so callers don't see stale `pending`
      // between sweeper ticks. The sweeper still does the durable
      // status flip + watch-event emission; this just smooths reads.
      return success(deriveExpired(parsed, new Date()));
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
      // Materialize the key list FIRST. Calling `await kv.get(key)`
      // inside the `for await` body causes the underlying ordered
      // consumer that powers `kv.keys()` to terminate early in
      // nats.js v2.29 — the consumer's "no pending" stop condition
      // fires while the loop body is suspended on the round-trip,
      // leaving the QueuedIterator drained after only a couple of
      // entries. Two passes (drain keys, then fetch each) is the
      // simple fix and acceptable: bucket sizes are bounded by the
      // sweeper's expiration cadence.
      const keysIter = await kv.keys();
      const keys: string[] = [];
      for await (const key of keysIter) keys.push(key);
      const out: Elicitation[] = [];
      const now = new Date();
      for (const key of keys) {
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
        // Read-time derivation: a past-deadline pending entry must
        // surface as `expired` to filters and consumers, even before
        // the durable sweep flips its KV status.
        const view = deriveExpired(elicitation, now);
        if (input.workspaceId !== undefined && view.workspaceId !== input.workspaceId) continue;
        if (input.sessionId !== undefined && view.sessionId !== input.sessionId) continue;
        if (input.status !== undefined && view.status !== input.status) {
          continue;
        }
        out.push(view);
      }
      out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return success(out);
    } catch (err) {
      return fail(stringifyError(err));
    }
  }

  private async transitionPending(
    id: string,
    makeNext: (current: Elicitation) => Elicitation,
  ): Promise<Result<Elicitation, string>> {
    try {
      const kv = await this.kv();
      const entry = await kv.get(id);
      if (!entry || entry.operation !== "PUT") {
        return fail(`Elicitation ${id} not found`);
      }

      const current = ElicitationSchema.parse(JSON.parse(dec.decode(entry.value)));
      if (current.status !== "pending") {
        return fail(`Elicitation ${id} already in terminal state: ${current.status}`);
      }
      // `workspace-setup` may sit unanswered for days — see
      // `expirePending` and `deriveExpired` for the sweep/read exemptions.
      // Mirror them here so a delayed answer isn't rejected as expired.
      if (current.kind !== "workspace-setup") {
        const expiresAtMs = new Date(current.expiresAt).getTime();
        if (Date.now() > expiresAtMs + TERMINAL_ANSWER_GRACE_MS) {
          return fail(`Elicitation ${id} already expired`);
        }
      }

      const next = ElicitationSchema.parse(makeNext(current));
      const body = enc.encode(JSON.stringify(next));
      try {
        await kv.update(id, body, entry.revision);
      } catch (err) {
        if (!isCASConflict(err)) throw err;
        const latest = await this.get({ id });
        const status = latest.ok && latest.data ? latest.data.status : "unknown";
        return fail(`Elicitation ${id} already in terminal state: ${status}`);
      }

      try {
        await this.publishEnvelope(next);
      } catch (err) {
        logger.warn("Failed to publish terminal elicitation envelope after KV update", {
          elicitationId: id,
          status: next.status,
          error: stringifyError(err),
        });
      }
      return success(next);
    } catch (err) {
      return fail(stringifyError(err));
    }
  }

  async answer(input: {
    id: string;
    answer: ElicitationAnswer;
  }): Promise<Result<Elicitation, string>> {
    return await this.transitionPending(input.id, (current) => ({
      ...current,
      status: "answered",
      answer: input.answer,
    }));
  }

  async decline(input: { id: string; note?: string }): Promise<Result<Elicitation, string>> {
    return await this.transitionPending(input.id, (current) => ({
      ...current,
      status: "declined",
      answer: {
        value: "declined",
        ...(input.note ? { note: input.note } : {}),
        answeredAt: new Date().toISOString(),
      },
    }));
  }

  /**
   * Sweep past-deadline `pending` entries and durably flip them to
   * `expired`. Called by the daemon-side sweeper on a timer (default
   * 60s) so KV/stream consumers see the terminal state without waiting
   * for an answer/decline that will never come.
   *
   * **CAS-guarded write**: we read the entry's KV revision, then write
   * via {@link KV.update}; if a concurrent `/answer` or `/decline`
   * lands between the read and write the CAS fails and we skip — the
   * answer wins. Idempotent across ticks: an already-`expired` entry
   * is filtered out before the write attempt.
   *
   * **Bounded work**: stop after `limit` entries per tick. The next
   * tick picks up any backlog. Mirrors the artifacts-sweeper cap so
   * one sweep can't monopolize the daemon if a backlog accumulates.
   */
  async expirePending(
    input: { now?: Date; limit?: number } = {},
  ): Promise<Result<ExpireSweepResult, string>> {
    const now = input.now ?? new Date();
    const limit = input.limit ?? 500;
    const expired: string[] = [];
    const skipped: string[] = [];
    let scanned = 0;
    let errors = 0;
    try {
      const kv = await this.kv();
      // Same two-pass key/get pattern as `list()` — fetching each entry
      // inside the keys() iterator drains the underlying ordered
      // consumer prematurely (see comment in list()).
      const keysIter = await kv.keys();
      const keys: string[] = [];
      for await (const key of keysIter) keys.push(key);

      for (const key of keys) {
        if (expired.length >= limit) break;
        scanned += 1;
        const entry = await kv.get(key);
        if (!entry || entry.operation !== "PUT") continue;

        let elicitation: Elicitation;
        try {
          elicitation = ElicitationSchema.parse(JSON.parse(dec.decode(entry.value)));
        } catch (parseErr) {
          logger.warn("expirePending: skipping malformed entry", {
            key,
            error: stringifyError(parseErr),
          });
          continue;
        }
        if (elicitation.status !== "pending") continue; // idempotent
        // `workspace-setup` may sit unanswered for days while the user
        // wires up credentials or hunts down a value; the 30-minute
        // sweep would silently kill those flows.
        if (elicitation.kind === "workspace-setup") continue;
        if (new Date(elicitation.expiresAt).getTime() > now.getTime()) continue; // not yet due

        const next: Elicitation = { ...elicitation, status: "expired" };
        const body = enc.encode(JSON.stringify(next));
        try {
          // KV is the source of truth for terminal-state arbitration.
          // CAS first so concurrent answer/decline wins cannot leak a
          // stale `expired` envelope to live waiters. Publish only after
          // the revision update succeeds; waiters also poll KV, so a
          // post-CAS publish hiccup does not wedge the blocked run.
          await kv.update(elicitation.id, body, entry.revision);
          try {
            await this.publishEnvelope(next);
          } catch (publishErr) {
            logger.warn("expirePending: publish after KV update failed", {
              elicitationId: elicitation.id,
              error: stringifyError(publishErr),
            });
          }
          expired.push(elicitation.id);
        } catch (err) {
          if (isCASConflict(err)) {
            skipped.push(elicitation.id);
            logger.info("expirePending: CAS skip — concurrent transition", {
              elicitationId: elicitation.id,
            });
            continue;
          }
          errors += 1;
          logger.warn("expirePending: per-entry write failed", {
            elicitationId: elicitation.id,
            error: stringifyError(err),
          });
        }
      }
      return success({ scanned, expired, skipped, errors });
    } catch (err) {
      return fail(stringifyError(err));
    }
  }

  /**
   * Re-publish an envelope to the stream without touching the KV.
   * Used by {@link expirePending} after a CAS-guarded KV update so the
   * stream stays in sync without overwriting the revision we just
   * acquired. The TTL math is intentionally identical to
   * {@link writeEnvelope} (1s floor) — past-expired entries hit the
   * floor, so the broker drops the envelope quickly after delivery.
   */
  private async publishEnvelope(elicitation: Elicitation): Promise<void> {
    await this.ensureStream();
    const subject = subjectFor(elicitation);
    const body = enc.encode(JSON.stringify(elicitation));
    const ttlMs = Math.max(1000, new Date(elicitation.expiresAt).getTime() - Date.now());
    const h = natsHeaders();
    h.set("Nats-TTL", `${Math.floor(ttlMs / 1000)}s`);
    // Same dedup-msg-id as writeEnvelope so retried terminal publishes
    // collapse cleanly within the broker dedup window.
    h.set("Nats-Msg-Id", `${elicitation.id}:${elicitation.status}`);
    const js = this.nc.jetstream();
    await js.publish(subject, body, { headers: h });
  }
}

/**
 * Read-time projection: surface `status: "expired"` for a `pending`
 * entry whose `expiresAt` has passed. Pure function — does not touch
 * the KV. Pairs with the durable {@link
 * JetStreamElicitationStorageAdapter.expirePending} sweep so consumers
 * never see a stale `pending` between sweeper ticks.
 */
function deriveExpired(elicitation: Elicitation, now: Date): Elicitation {
  if (elicitation.status !== "pending") return elicitation;
  if (elicitation.kind === "workspace-setup") return elicitation;
  if (new Date(elicitation.expiresAt).getTime() > now.getTime()) {
    return elicitation;
  }
  return { ...elicitation, status: "expired" };
}

/**
 * Provision the ELICITATIONS stream with the current desired config —
 * single source of truth shared by the bootstrap migration
 * (`apps/atlasd/src/migrations/m_20260505_120000_elicitations_bootstrap.ts`)
 * and the test setup (`vitest.setup.ts`).
 *
 * Idempotent: creates if missing, otherwise updates in place so a
 * legacy daemon picks up `allow_msg_ttl: true`. Production callers run
 * this exactly once at startup (the migration) before any code path
 * touches `ElicitationStorage`. The adapter then only validates — see
 * `JetStreamElicitationStorageAdapter.ensureStream`.
 */
export async function bootstrapElicitationsStream(nc: NatsConnection): Promise<void> {
  const jsm = await nc.jetstreamManager();
  // The nats.js v2.29 StreamConfig type doesn't expose `allow_msg_ttl`
  // (server-side JSON only) — cast through unknown. NATS 2.11+ rejects
  // the `Nats-TTL` header without this flag.
  const cfg = {
    name: STREAM_NAME,
    subjects: [`${SUBJECT_PREFIX}.>`],
    retention: RetentionPolicy.Limits,
    storage: StorageType.File,
    // Coarse upper-bound retention. The runtime adapter publishes with
    // per-message `Nats-TTL` headers derived from each elicitation's
    // `expiresAt`; this max_age caps how long declined/answered
    // envelopes hang around for the Activity page audit feed.
    max_age: 7 * 24 * 60 * 60 * 1_000_000_000,
    allow_msg_ttl: true,
  } as unknown as Parameters<typeof jsm.streams.add>[0];
  try {
    await jsm.streams.info(STREAM_NAME);
    await jsm.streams.update(STREAM_NAME, cfg);
  } catch (err) {
    if (!isStreamNotFound(err)) throw err;
    await jsm.streams.add(cfg);
  }
}
