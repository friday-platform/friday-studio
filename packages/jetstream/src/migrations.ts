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

import type { Logger } from "@atlas/logger";
import { stringifyError } from "@atlas/utils";
import type { NatsConnection } from "nats";
import { createJetStreamFacade, type JetStreamFacade } from "./facade.ts";
import { dec, enc, readKvJson } from "./helpers.ts";

/** KV bucket holding the migration audit trail. Internal — don't read by hand. */
export const MIGRATIONS_BUCKET = "_FRIDAY_MIGRATIONS";

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
   * would happen. Used by `atlas migrate --dry-run`.
   */
  dryRun?: boolean;
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

  const result: RunMigrationsResult = { ran: [], skipped: [], failed: [] };

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
      logger.info("Migration complete", { id: m.id, name: m.name, durationMs: record.durationMs });
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

  return result;
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
