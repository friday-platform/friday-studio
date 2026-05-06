/**
 * Pre-NATS migration registry.
 *
 * Pre-NATS migrations are filesystem-only steps that run before any NATS
 * connection. They execute sequentially in registry order; the first
 * failure stops the queue AND prevents the post-NATS phase from running
 * (`connectOrSpawn` is skipped).
 *
 * Discovery is intentionally manual — pre-NATS migrations are expected to
 * be rare, and a flat registry catches typos at module-load time rather
 * than at directory-scan time. Contrast with `apps/atlasd/src/migrations/`
 * which auto-discovers `m_*.ts` files.
 */

import type { Logger } from "@atlas/logger";
import { relocateStore } from "./relocate-store.ts";
import type { MigrationOutcome, PreNatsMigration } from "./types.ts";

// To add a new pre-NATS migration, append to this array.
export const preNatsMigrations: PreNatsMigration[] = [relocateStore];

export interface PreNatsRunResult {
  outcomes: MigrationOutcome[];
  /** True when a migration returned `status: error` and the queue stopped
   *  short of running every entry — and post-NATS work should also be
   *  skipped. */
  aborted: boolean;
}

/**
 * Run every pre-NATS migration in registry order. Stops at the first
 * `status: error`; returns the partial outcome list with `aborted: true`.
 *
 * Logger is passed through to each entry. Each entry emits its own
 * resolved-paths log line at the start of `run()`; this runner does not
 * add additional log output of its own.
 *
 * The optional `entries` parameter is for tests that want to substitute
 * the default registry (e.g. to verify first-failure-aborts-queue
 * semantics with stub entries). Production callers omit it.
 */
export async function runPreNatsMigrations(
  logger: Logger,
  opts: { dryRun: boolean },
  entries: PreNatsMigration[] = preNatsMigrations,
): Promise<PreNatsRunResult> {
  const outcomes: MigrationOutcome[] = [];
  for (const migration of entries) {
    let outcome: MigrationOutcome;
    try {
      outcome = await migration.run({ logger, dryRun: opts.dryRun });
    } catch (err) {
      // A pre-NATS entry threw outside its declared error contract.
      // Surface as a synthetic error outcome so the JSON shape stays
      // consistent for consumers (Tauri, scripts).
      outcome = {
        id: migration.id,
        status: "error",
        legacy_path: "",
        target_path: "",
        target_source: "default",
        error: { kind: "unknown", message: err instanceof Error ? err.message : String(err) },
        duration_ms: 0,
      };
    }
    outcomes.push(outcome);
    if (outcome.status === "error") {
      return { outcomes, aborted: true };
    }
  }
  return { outcomes, aborted: false };
}

/** Return the set of registered entries' metadata, for `--list` output. */
export function listPreNatsEntries(): { id: string; name: string; description: string }[] {
  return preNatsMigrations.map((m) => ({ id: m.id, name: m.name, description: m.description }));
}
