/**
 * `atlas migrate` — run pending data migrations. Idempotent.
 *
 *   atlas migrate                run pending migrations
 *   atlas migrate --list         show every migration entry + status
 *   atlas migrate --dry-run      report what would run without changing state
 *   atlas migrate --json         machine-readable output
 *
 * Refuses to run mutations while the daemon is up (the daemon owns the
 * KV migration lock and runs the same queue at startup). `--list` and
 * `--dry-run` work either way.
 */

import { join } from "node:path";
import process from "node:process";
import { getAllMigrations } from "@atlas/atlasd/migrations";
import { logger } from "@atlas/logger";
import { stringifyError } from "@atlas/utils";
import { getFridayHome } from "@atlas/utils/paths.server";
import { load } from "@std/dotenv";
import {
  type ConnectionHandle,
  connectOrSpawn,
  listMigrationRecords,
  MigrationLockError,
  type MigrationRecord,
  readJetStreamConfig,
  resolveNatsUrl,
  runMigrations,
} from "jetstream";
import {
  listPreNatsEntries,
  preNatsMigrations,
  runPreNatsMigrations,
} from "../pre-nats-migrations/index.ts";
import { acquirePreNatsLock, LockBusyError, type LockHandle } from "../pre-nats-migrations/lock.ts";
import type { MigrationOutcome } from "../pre-nats-migrations/types.ts";
import { errorOutput, infoOutput, successOutput } from "../utils/output.ts";
import type { YargsInstance } from "../utils/yargs.ts";

interface MigrateArgs {
  list?: boolean;
  dryRun?: boolean;
  json?: boolean;
  natsUrl?: string;
  noSpawn?: boolean;
}

export const command = "migrate";
export const desc = "Run pending data migrations against NATS";

export function builder(y: YargsInstance) {
  return y
    .option("list", {
      type: "boolean",
      describe: "List every migration entry + its current status; don't run anything",
      default: false,
    })
    .option("dry-run", {
      type: "boolean",
      describe: "Report what would run without changing state",
      default: false,
    })
    .option("json", { type: "boolean", describe: "Output as JSON", default: false })
    .option("nats-url", {
      type: "string",
      describe: "Override NATS broker URL (defaults to FRIDAY_NATS_URL or nats://localhost:4222)",
    })
    .option("no-spawn", {
      type: "boolean",
      describe:
        "Disable the auto-spawn fallback. By default the CLI spawns an ephemeral nats-server " +
        "if no broker is reachable and FRIDAY_NATS_URL isn't set; --no-spawn fails instead.",
      default: false,
    })
    .example("$0 migrate", "Run any pending migrations")
    .example("$0 migrate --list", "Show migration status")
    .example("$0 migrate --dry-run", "Preview what would run");
}

/**
 * Load `<friday_home>/.env` into `process.env` so subsequent reads see the
 * installer's port remap (and any other operator-set values). Tolerant —
 * missing `.env` is fine on a fresh dev install. The installer always
 * writes `.env` before invoking `friday migrate`.
 */
export async function loadFridayEnv(fridayHome: string): Promise<void> {
  try {
    await load({ envPath: join(fridayHome, ".env"), export: true });
  } catch {
    // .env may not exist yet (fresh install); that's fine, defaults apply.
  }
}

export const handler = async (argv: MigrateArgs): Promise<void> => {
  // 1. Load .env BEFORE any other process.env reads. The daemon-alive
  //    probe and the @std/dotenv-aware downstream code both depend on
  //    this happening at handler entry.
  const fridayHome = getFridayHome();
  await loadFridayEnv(fridayHome);

  const isReadOnly = argv.list || argv.dryRun;

  // 2. --list: enumerate both pre-NATS and post-NATS entries, no
  //    mutating work. Daemon-alive does not gate read-only ops.
  if (argv.list) {
    await handleList(argv);
    return;
  }

  // 3. For mutating runs, refuse if a daemon is reachable. The daemon
  //    runs the post-NATS queue at startup under the same lock, so racing
  //    it would just produce a `MigrationLockError` later — fail early
  //    with a friendlier message. `--dry-run` skips this check (read-only).
  if (!isReadOnly && (await isDaemonRunning())) {
    const port = process.env.FRIDAY_PORT_FRIDAY ?? "8080";
    errorOutput(
      `Daemon is running on http://localhost:${port} — restart it to apply pending ` +
        "migrations (`atlas daemon restart`), or stop it to run them standalone. " +
        "`atlas migrate --list` and `--dry-run` work while the daemon is up.",
    );
    process.exit(1);
  }

  // 4. Pre-NATS migrations. For mutating runs, acquire the PID lock;
  //    release IMMEDIATELY after the queue finishes (before connectOrSpawn).
  //    Read-only / dry-run ops skip the lock entirely.
  let lock: LockHandle | null = null;
  if (!isReadOnly) {
    try {
      lock = await acquirePreNatsLock(fridayHome);
    } catch (err) {
      if (err instanceof LockBusyError) {
        errorOutput(err.message);
        process.exit(1);
      }
      errorOutput(stringifyError(err));
      process.exit(1);
    }
  }

  let preNatsResult: { outcomes: MigrationOutcome[]; aborted: boolean };
  try {
    preNatsResult = await runPreNatsMigrations(logger, { dryRun: !!argv.dryRun });
  } finally {
    if (lock) {
      await lock.release();
    }
  }

  // 5. If pre-NATS aborted, report and skip post-NATS entirely.
  if (preNatsResult.aborted) {
    if (argv.json) {
      // Single-line JSON on stdout for any tool that wants to parse
      // `--json` output (CI scripts, future integrations). Pretty-
      // printing would split the outcome across lines that don't
      // individually parse. Exit nonzero so callers that key on exit
      // code see the failure regardless.
      console.log(
        JSON.stringify({ preNats: preNatsResult.outcomes, ran: [], skipped: [], failed: [] }),
      );
      process.exit(1);
    }
    const last = preNatsResult.outcomes[preNatsResult.outcomes.length - 1];
    const errKind = last?.error?.kind ?? "unknown";
    const errMsg = last?.error?.message ?? "(no message)";
    errorOutput(`pre-NATS migration ${last?.id} failed (${errKind}): ${errMsg}`);
    process.exit(1);
  }

  // 6. Post-NATS phase: connect to NATS and run the KV-backed queue.
  await runPostNatsPhase(argv, preNatsResult.outcomes);
};

async function handleList(argv: MigrateArgs): Promise<void> {
  const url = resolveNatsUrl({ url: argv.natsUrl });
  const cfg = readJetStreamConfig();
  const storeDir = cfg.server.storeDir.value ?? join(getFridayHome(), "jetstream");

  // Pre-NATS list works even if NATS is unreachable — collect first.
  const preEntries = listPreNatsEntries();

  let handle: ConnectionHandle;
  try {
    handle = await connectOrSpawn({
      url,
      name: "atlas-cli-migrate",
      storeDir,
      spawnFallback: !argv.noSpawn,
      logger,
    });
  } catch (err) {
    errorOutput(stringifyError(err));
    process.exit(1);
  }
  const { nc, cleanup } = handle;
  try {
    const migrations = await getAllMigrations();
    const records = await listMigrationRecords(nc);
    const byId = new Map(records.map((r) => [r.id, r]));
    const entries = migrations.map((m) => ({
      id: m.id,
      name: m.name,
      description: m.description,
      record: byId.get(m.id) ?? null,
    }));
    if (argv.json) {
      // Single-line for `--json` parseability — see runPostNatsPhase.
      console.log(JSON.stringify({ preNats: preEntries, migrations: entries }));
      return;
    }
    printPreNatsList(preEntries);
    printList(entries);
  } finally {
    await cleanup();
  }
}

async function runPostNatsPhase(argv: MigrateArgs, preNats: MigrationOutcome[]): Promise<void> {
  const url = resolveNatsUrl({ url: argv.natsUrl });
  const cfg = readJetStreamConfig();
  const storeDir = cfg.server.storeDir.value ?? join(getFridayHome(), "jetstream");

  let handle: ConnectionHandle;
  try {
    handle = await connectOrSpawn({
      url,
      name: "atlas-cli-migrate",
      storeDir,
      spawnFallback: !argv.noSpawn,
      logger,
    });
  } catch (err) {
    errorOutput(stringifyError(err));
    process.exit(1);
  }

  const { nc, cleanup } = handle;
  try {
    const migrations = await getAllMigrations();
    const result = await runMigrations(nc, migrations, logger, {
      dryRun: !!argv.dryRun,
      runner: "cli",
    });
    if (argv.json) {
      // Single-line JSON for any tool that wants to parse `--json`
      // output. Pretty-printing would split the outcome across lines
      // that don't individually parse. Exit nonzero on failure so
      // callers that key on exit code see it without having to peek
      // inside the JSON body.
      console.log(
        JSON.stringify({
          preNats,
          ran: result.ran,
          skipped: result.skipped,
          failed: result.failed,
        }),
      );
      if (result.failed.length > 0) {
        process.exit(1);
      }
      return;
    }
    if (argv.dryRun) {
      infoOutput(`[dry-run] would run ${result.ran.length}, skip ${result.skipped.length}`);
      for (const id of result.ran) infoOutput(`  • ${id}`);
      return;
    }
    if (result.failed.length > 0) {
      errorOutput(`${result.failed.length} migration(s) failed: ${result.failed.join(", ")}`);
      process.exit(1);
    }
    successOutput(
      `ran ${result.ran.length} migration(s); skipped ${result.skipped.length} already applied`,
    );
  } catch (err) {
    if (err instanceof MigrationLockError) {
      errorOutput(
        `${err.message}\n` +
          "If a daemon is starting up, wait for it to finish; otherwise the lock " +
          "auto-expires after 10 minutes.",
      );
      process.exit(1);
    }
    errorOutput(stringifyError(err));
    process.exit(1);
  } finally {
    await cleanup();
  }
}

/**
 * Cheap probe of the daemon's /health endpoint. 500ms timeout is enough
 * on localhost; failure modes (DNS, connection refused, timeout) all
 * fall through to "no daemon" which is the safe default — the lock in
 * `runMigrations` is the actual correctness guard.
 *
 * Reads `FRIDAY_PORT_FRIDAY` from `process.env` (already populated by
 * `loadFridayEnv` at handler entry) so the probe sees the installer's
 * remapped port (typically 18080) rather than the legacy default 8080.
 */
export async function isDaemonRunning(): Promise<boolean> {
  const port = process.env.FRIDAY_PORT_FRIDAY ?? "8080";
  try {
    const res = await fetch(`http://localhost:${port}/health`, {
      signal: AbortSignal.timeout(500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

interface MigrationEntry {
  id: string;
  name: string;
  description?: string;
  record: MigrationRecord | null;
}

function printPreNatsList(entries: ReturnType<typeof listPreNatsEntries>): void {
  if (entries.length === 0) return;
  for (const e of entries) {
    console.log(`[pre-NATS] ${e.id}  ${e.name}`);
    console.log(`  ${e.description}`);
    console.log("");
  }
}

function printList(entries: MigrationEntry[]): void {
  if (entries.length === 0) {
    infoOutput("(no migrations registered)");
    return;
  }
  for (const e of entries) {
    const status = e.record
      ? e.record.success
        ? `✓ ${e.record.ranAt} (${e.record.durationMs}ms)`
        : `✗ ${e.record.ranAt} — ${e.record.error ?? "unknown error"}`
      : "· pending";
    console.log(`${e.id}  ${e.name}`);
    console.log(`  ${status}`);
    if (e.description) {
      console.log(`  ${e.description}`);
    }
    console.log("");
  }
}

// Re-export for tests.
export { preNatsMigrations };
