/**
 * `atlas migrate` — run pending data migrations directly against NATS.
 *
 * Standalone: connects to the broker (FRIDAY_NATS_URL or default
 * localhost:4222), invokes `runMigrations` from the `jetstream` package
 * — same function the daemon's startup hook calls. No daemon HTTP API
 * involved; the CLI is independent of daemon lifecycle.
 *
 *   atlas migrate                run pending migrations
 *   atlas migrate --list         show every migration entry + status
 *   atlas migrate --dry-run      report what would run without changing state
 *   atlas migrate --json         machine-readable output
 *
 * Daemon also runs the same queue at startup; this command is for
 * recovery scenarios (daemon down + want to inspect / advance state)
 * and for CI/CD pipelines that want to migrate before starting the
 * daemon. Idempotent — re-running is safe.
 *
 * Caveat: in the solo-dev default the daemon spawns nats-server, so
 * if the daemon is down NATS is also down — the CLI will surface a
 * connection error pointing the operator at `atlas daemon start` or
 * external NATS.
 */

import { join } from "node:path";
import process from "node:process";
import { getAllMigrations } from "@atlas/atlasd/migrations";
import { logger } from "@atlas/logger";
import { stringifyError } from "@atlas/utils";
import { getFridayHome } from "@atlas/utils/paths.server";
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

export const handler = async (argv: MigrateArgs): Promise<void> => {
  const url = resolveNatsUrl({ url: argv.natsUrl });
  // Same store_dir resolution the daemon uses — env override → daemon
  // home / jetstream. So if we end up auto-spawning, the spawn reads
  // (and writes) the same JetStream data the daemon would have served.
  const cfg = readJetStreamConfig();
  const storeDir = cfg.server.storeDir.value ?? join(getFridayHome(), "jetstream");

  // For mutating runs only: refuse if a daemon is reachable. The daemon
  // runs the same queue at startup under the same lock, so racing it
  // would just produce a `MigrationLockError` later — fail early with a
  // friendlier message. `--list` and `--dry-run` are read-only and stay
  // available for inspection while the daemon is up.
  const isReadOnly = argv.list || argv.dryRun;
  if (!isReadOnly && (await isDaemonRunning())) {
    errorOutput(
      "Daemon is running on http://localhost:8080 — restart it to apply pending " +
        "migrations (`atlas daemon restart`), or stop it to run them standalone. " +
        "`atlas migrate --list` and `--dry-run` work while the daemon is up.",
    );
    process.exit(1);
  }

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
    if (argv.list) {
      const records = await listMigrationRecords(nc);
      const byId = new Map(records.map((r) => [r.id, r]));
      const entries = migrations.map((m) => ({
        id: m.id,
        name: m.name,
        description: m.description,
        record: byId.get(m.id) ?? null,
      }));
      if (argv.json) {
        console.log(JSON.stringify({ migrations: entries }, null, 2));
        return;
      }
      printList(entries);
      return;
    }

    const result = await runMigrations(nc, migrations, logger, {
      dryRun: !!argv.dryRun,
      runner: "cli",
    });
    if (argv.json) {
      console.log(JSON.stringify(result, null, 2));
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
};

/**
 * Cheap probe of the daemon's /health endpoint. 500ms timeout is enough
 * on localhost; failure modes (DNS, connection refused, timeout) all
 * fall through to "no daemon" which is the safe default — the lock in
 * `runMigrations` is the actual correctness guard.
 */
async function isDaemonRunning(): Promise<boolean> {
  try {
    const res = await fetch("http://localhost:8080/health", { signal: AbortSignal.timeout(500) });
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
