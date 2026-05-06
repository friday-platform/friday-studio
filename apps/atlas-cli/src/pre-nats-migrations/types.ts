/**
 * Pre-NATS migration interfaces.
 *
 * Pre-NATS migrations run before any NATS connection — they operate on the
 * filesystem only and ship in the atlas-cli binary. The post-NATS
 * migrations live in `apps/atlasd/src/migrations/` and are KV-backed; the
 * two queues are intentionally separate (different lifecycle, different
 * lock, different runner). See
 * `docs/plans/2026-05-05-jetstream-store-migration-design.v6.md` for the
 * full contract.
 */

import type { Logger } from "@atlas/logger";

/** Source of the resolved target path — `env` if FRIDAY_JETSTREAM_STORE_DIR
 *  was set, `default` if we computed `<friday_home>/jetstream`. */
export type TargetSource = "env" | "default";

/** Why a migration ended up in `error` status. */
export type ErrorKind = "copy_failed" | "permission_denied" | "disk_full" | "lock_busy" | "unknown";

/** A single pre-NATS migration's outcome — exactly the shape promised to the
 *  Tauri command and `friday migrate --json`. */
export interface MigrationOutcome {
  id: string;
  status: "migrated" | "noop" | "skipped" | "legacy_equals_target" | "error";
  legacy_path: string;
  target_path: string;
  target_source: TargetSource;
  /** Streams counted at the source. Populated for `migrated` and (best-effort) `skipped`. */
  streams_moved?: number;
  /** Total bytes moved on the wire. Populated for `migrated`; 0 in dry-run. */
  bytes_moved?: number;
  duration_ms: number;
  error?: { kind: ErrorKind; message: string };
  /** Free-form short tag for non-error statuses (e.g. `dest_not_empty`). */
  reason?: string;
}

/** Context passed into each pre-NATS migration's `run()`. */
export interface PreNatsContext {
  logger: Logger;
  dryRun: boolean;
}

/** A single registered pre-NATS migration. */
export interface PreNatsMigration {
  id: string;
  name: string;
  description: string;
  run(ctx: PreNatsContext): Promise<MigrationOutcome>;
}
