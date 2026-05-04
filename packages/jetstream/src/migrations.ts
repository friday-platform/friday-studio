/**
 * One-shot, idempotent migration framework backed by a JetStream KV bucket.
 *
 * Each migration carries a stable string `id` (we use the commit SHA of
 * the commit that introduced it — tags are created after the fact so they
 * make poor identifiers; SHAs are immutable from the moment a commit
 * exists). The framework records `{ id, name, ranAt, durationMs, success }`
 * on completion; subsequent runs read the record and skip migrations
 * that already succeeded.
 *
 * Idempotency is a TWO-PART contract:
 *   1. The framework prevents re-running by checking the KV record.
 *   2. The migration's `run()` body MUST itself be safely re-runnable —
 *      if the record is lost (broker rebuild, manual purge) or the
 *      migration ran partially before crashing, re-running can't corrupt
 *      data. Concretely: check-then-write (e.g. "if KV entry exists,
 *      skip"), purge-then-republish patterns, count-verification at the
 *      end. The existing chat-migration and memory-migration are
 *      examples of correctly-written idempotent migrations.
 *
 * On first failure the runner stops — subsequent migrations may depend
 * on an earlier one's output and shouldn't run on dirty state.
 */

import { hostname } from "node:os";
import process from "node:process";
import type { Logger } from "@atlas/logger";
import { stringifyError } from "@atlas/utils";
import type { KV, NatsConnection } from "nats";
import { createJetStreamFacade, type JetStreamFacade } from "./facade.ts";
import { dec, enc, isCASConflict, readKvJson } from "./helpers.ts";

/** KV bucket holding the migration audit trail. Internal — don't read by hand. */
export const MIGRATIONS_BUCKET = "_FRIDAY_MIGRATIONS";

/**
 * Lock key inside the audit bucket. A leading underscore keeps it out of
 * the way of migration-id keys (which are timestamp-prefixed slugs).
 */
const LOCK_KEY = "_lock";

/**
 * Generous TTL — covers any plausible upgrade-boot run on legacy data.
 * The lock is auto-recovered after expiry, so a daemon crash mid-migration
 * doesn't leave a permanent block requiring manual KV surgery.
 */
const LOCK_TTL_MS = 10 * 60_000;

interface LockRecord {
  holder: string;
  acquiredAt: string;
  expiresAt: string;
}

/**
 * Thrown when another runner holds the migration lock. Caught by call
 * sites that want to surface a friendlier message ("daemon is starting
 * up, wait or restart it"); otherwise it propagates as a regular error.
 */
export class MigrationLockError extends Error {
  constructor(
    message: string,
    public readonly holder: string,
    public readonly expiresAt: string,
  ) {
    super(message);
    this.name = "MigrationLockError";
  }
}

export interface Migration {
  /**
   * Stable, unique identifier — by convention the short commit SHA of
   * the commit that introduces this migration. New migrations get a
   * placeholder until the commit lands; then the SHA is filled in.
   * Once committed, NEVER change this value.
   */
  id: string;
  /** Human-readable name for logs / CLI output. */
  name: string;
  /** Optional longer description shown in `atlas migrate --list`. */
  description?: string;
  /**
   * Run the migration. MUST be idempotent — see the file-level docstring
   * for the contract. Throw on unrecoverable error; the runner will
   * record `success: false` and abort the remaining queue.
   */
  run(ctx: MigrationContext): Promise<void>;
}

export interface MigrationContext {
  nc: NatsConnection;
  js: JetStreamFacade;
  logger: Logger;
}

export interface MigrationRecord {
  id: string;
  name: string;
  /** ISO 8601 of when the migration completed (success or failure). */
  ranAt: string;
  durationMs: number;
  success: boolean;
  /** Populated when success === false. */
  error?: string;
}

export interface RunMigrationsResult {
  ran: string[];
  skipped: string[];
  failed: string[];
}

export interface RunMigrationsOptions {
  /**
   * Don't actually run migrations or write records — just report what
   * would happen. Used by `atlas migrate --dry-run`. Skips the lock
   * because the operation is read-only.
   */
  dryRun?: boolean;
  /**
   * Short label identifying who is running migrations — `"daemon"` for
   * the boot-time hook, `"cli"` for `atlas migrate`. Recorded in the
   * lock record so contention errors point at the right process.
   */
  runner?: string;
}

/**
 * Run every migration in `migrations` whose id isn't already recorded
 * as successful in the `_FRIDAY_MIGRATIONS` KV bucket. Returns a summary
 * of which IDs ran / were skipped / failed.
 *
 * Order: migrations run in array order. The framework does not enforce
 * dependency ordering — caller is responsible for declaring them in the
 * right sequence.
 */
export async function runMigrations(
  nc: NatsConnection,
  migrations: Migration[],
  logger: Logger,
  opts: RunMigrationsOptions = {},
): Promise<RunMigrationsResult> {
  // Reject duplicate ids across ALL_MIGRATIONS. The framework keys the
  // audit trail by id, so two entries sharing an id silently skip the
  // second one (real bug we hit when both new migrations used the
  // literal `__pending__` placeholder). Convention: stable slugs like
  // `mcp-registry-to-jetstream`. Catch at runtime; better to fail loud
  // than silently skip a data migration.
  const seen = new Set<string>();
  for (const m of migrations) {
    if (seen.has(m.id)) {
      throw new Error(
        `Duplicate migration id "${m.id}" (entry "${m.name}"). ` +
          "Migration ids must be unique across ALL_MIGRATIONS — the framework keys " +
          "the audit trail by id, so duplicates would silently skip the second entry. " +
          "Use a stable slug like 'cron-timers-to-jetstream' (not commit SHAs — " +
          "amends churn the id and orphan the audit trail).",
      );
    }
    seen.add(m.id);
  }

  const js = createJetStreamFacade(nc);
  const kv = await js.kv.getOrCreate(MIGRATIONS_BUCKET, { history: 5 });

  // Read-only paths skip the lock — they don't mutate audit state and
  // shouldn't block on another runner.
  const acquireLock = !opts.dryRun;
  const runner = opts.runner ?? "unknown";
  let releaseLock: (() => Promise<void>) | null = null;
  if (acquireLock) {
    releaseLock = await acquireMigrationLock(kv, runner, logger);
  }

  const result: RunMigrationsResult = { ran: [], skipped: [], failed: [] };

  try {
    for (const m of migrations) {
      const existing = await readKvJson<MigrationRecord>(kv, m.id);
      if (existing?.success) {
        result.skipped.push(m.id);
        logger.debug("Migration already applied, skipping", {
          id: m.id,
          name: m.name,
          ranAt: existing.ranAt,
        });
        continue;
      }

      if (opts.dryRun) {
        result.ran.push(m.id);
        logger.info("[dry-run] Would run migration", { id: m.id, name: m.name });
        continue;
      }

      const startedAt = Date.now();
      logger.info("Running migration", { id: m.id, name: m.name });
      try {
        await m.run({ nc, js, logger });
        const record: MigrationRecord = {
          id: m.id,
          name: m.name,
          ranAt: new Date().toISOString(),
          durationMs: Date.now() - startedAt,
          success: true,
        };
        await kv.put(m.id, enc.encode(JSON.stringify(record)));
        result.ran.push(m.id);
        logger.info("Migration complete", {
          id: m.id,
          name: m.name,
          durationMs: record.durationMs,
        });
      } catch (err) {
        const record: MigrationRecord = {
          id: m.id,
          name: m.name,
          ranAt: new Date().toISOString(),
          durationMs: Date.now() - startedAt,
          success: false,
          error: stringifyError(err),
        };
        // Best-effort write — if this also fails the operator still gets
        // the error in logs, just no audit trail.
        try {
          await kv.put(m.id, enc.encode(JSON.stringify(record)));
        } catch {
          // Swallow — primary error already surfaced below.
        }
        result.failed.push(m.id);
        logger.error("Migration failed", { id: m.id, name: m.name, error: stringifyError(err) });
        // First failure aborts the rest — later migrations may depend on
        // earlier output. Operator fixes and reruns; idempotent ones that
        // succeeded above stay marked done and won't repeat.
        break;
      }
    }
  } finally {
    if (releaseLock) await releaseLock();
  }

  return result;
}

/**
 * Acquire the migration lock atomically via NATS KV `create` (succeeds
 * only when the key doesn't yet exist). Recovers from expired locks —
 * if the existing record's `expiresAt` is in the past we take it over
 * via CAS-on-revision. Otherwise throws `MigrationLockError` with the
 * current holder so callers can render a helpful message.
 *
 * Returns a release function the caller invokes in `finally` to delete
 * the lock. Failure to release is logged but doesn't throw — the TTL is
 * the safety net.
 */
async function acquireMigrationLock(
  kv: KV,
  runner: string,
  logger: Logger,
): Promise<() => Promise<void>> {
  const holder = `${runner}/${process.pid}@${hostname()}`;
  const now = Date.now();
  const record: LockRecord = {
    holder,
    acquiredAt: new Date(now).toISOString(),
    expiresAt: new Date(now + LOCK_TTL_MS).toISOString(),
  };
  const payload = enc.encode(JSON.stringify(record));

  // Fast path: key doesn't exist yet, `create` succeeds.
  try {
    await kv.create(LOCK_KEY, payload);
    logger.debug("Acquired migration lock", { holder, expiresAt: record.expiresAt });
    return () => releaseMigrationLock(kv, holder, logger);
  } catch (err) {
    if (!isCASConflict(err)) throw err;
  }

  // Slow path: a record exists. Read it; if expired, take over via CAS
  // on the existing revision.
  const existing = await kv.get(LOCK_KEY);
  if (existing && existing.operation === "PUT") {
    let parsed: LockRecord | null = null;
    try {
      parsed = JSON.parse(dec.decode(existing.value)) as LockRecord;
    } catch {
      parsed = null;
    }
    const expired = !parsed || Date.parse(parsed.expiresAt) <= now;
    if (expired) {
      try {
        await kv.update(LOCK_KEY, payload, existing.revision);
        logger.warn("Took over expired migration lock", {
          previousHolder: parsed?.holder,
          previousExpiresAt: parsed?.expiresAt,
          newHolder: holder,
        });
        return () => releaseMigrationLock(kv, holder, logger);
      } catch (err) {
        if (!isCASConflict(err)) throw err;
        // Lost the race to take over the expired lock — fall through to
        // the "still held" error using whoever beat us (re-read below).
      }
    }
    if (parsed && !expired) {
      throw new MigrationLockError(
        `Migration lock held by ${parsed.holder} (expires ${parsed.expiresAt}). ` +
          "Another runner is in progress; wait for it to finish or restart it.",
        parsed.holder,
        parsed.expiresAt,
      );
    }
  }

  // Either the entry was a tombstone or a concurrent acquirer beat us.
  // Re-read once for the error message; if even that fails, fall back
  // to a generic message.
  const recheck = await readKvJson<LockRecord>(kv, LOCK_KEY);
  throw new MigrationLockError(
    recheck
      ? `Migration lock held by ${recheck.holder} (expires ${recheck.expiresAt}). ` +
          "Another runner is in progress; wait for it to finish or restart it."
      : "Could not acquire migration lock; another runner is in progress.",
    recheck?.holder ?? "unknown",
    recheck?.expiresAt ?? new Date(now + LOCK_TTL_MS).toISOString(),
  );
}

async function releaseMigrationLock(kv: KV, holder: string, logger: Logger): Promise<void> {
  try {
    // Best-effort: only delete if WE still hold it. Reading first
    // catches the rare case where our lock expired and another runner
    // took over — deleting unconditionally would yank theirs.
    const current = await readKvJson<LockRecord>(kv, LOCK_KEY);
    if (current && current.holder === holder) {
      await kv.delete(LOCK_KEY);
      logger.debug("Released migration lock", { holder });
    } else if (current) {
      logger.warn("Migration lock no longer ours; not releasing", {
        ourHolder: holder,
        currentHolder: current.holder,
      });
    }
  } catch (err) {
    logger.warn("Failed to release migration lock; relying on TTL", {
      holder,
      error: stringifyError(err),
    });
  }
}

/**
 * Read every migration record (regardless of success). Used by the
 * `atlas migrate --list` CLI to render status. Returns records in the
 * order they were inserted into the KV (broker insertion order — KV
 * keys don't sort meaningfully when they're SHAs).
 */
export async function listMigrationRecords(nc: NatsConnection): Promise<MigrationRecord[]> {
  const js = createJetStreamFacade(nc);
  const kv = await js.kv.getOrCreate(MIGRATIONS_BUCKET, { history: 5 });
  const it = await kv.keys();
  const keys: string[] = [];
  for await (const k of it) keys.push(k);
  const records: MigrationRecord[] = [];
  for (const key of keys) {
    const entry = await kv.get(key);
    if (!entry || entry.operation !== "PUT") continue;
    try {
      records.push(JSON.parse(dec.decode(entry.value)) as MigrationRecord);
    } catch {
      // Malformed record — skip.
    }
  }
  records.sort((a, b) => a.ranAt.localeCompare(b.ranAt));
  return records;
}
