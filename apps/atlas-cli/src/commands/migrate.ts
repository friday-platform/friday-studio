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
import { errorOutput, infoOutput, successOutput } from "../utils/output.ts";
import type { YargsInstance } from "../utils/yargs.ts";
import { relocateJetStreamStore } from "./relocate-jetstream-store.ts";

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
 * Load `<friday_home>/.env` into `process.env` so subsequent reads see
 * the installer's port remap (and any other operator-set values).
 * Tolerant — missing `.env` is fine on a fresh dev install.
 */
export async function loadFridayEnv(fridayHome: string): Promise<void> {
  try {
    await load({ envPath: join(fridayHome, ".env"), export: true });
  } catch {
    // .env may not exist yet (fresh install); defaults apply.
  }
}

export const handler = async (argv: MigrateArgs): Promise<void> => {
  // .env load must happen before any process.env reads — the
  // daemon-alive probe below reads FRIDAY_PORT_FRIDAY from it.
  const fridayHome = getFridayHome();
  await loadFridayEnv(fridayHome);

  const isReadOnly = argv.list || argv.dryRun;

  if (argv.list) {
    await handleList(argv);
    return;
  }

  // The daemon owns the migration lock and runs the same queue at
  // startup. Racing it just yields a MigrationLockError later — refuse
  // up front with a friendlier message. Read-only ops skip this.
  if (!isReadOnly && (await isDaemonRunning())) {
    const port = process.env.FRIDAY_PORT_FRIDAY ?? "8080";
    errorOutput(
      `Daemon is running on http://localhost:${port} — restart it to apply pending ` +
        "migrations (`atlas daemon restart`), or stop it to run them standalone. " +
        "`atlas migrate --list` and `--dry-run` work while the daemon is up.",
    );
    process.exit(1);
  }

  // Move legacy data out of $TMPDIR before connecting to NATS — see
  // relocate-jetstream-store.ts. Skip on dry-run (don't mutate). Throws
  // on real errors (ENOSPC, etc.); we surface them and bail.
  if (!argv.dryRun) {
    try {
      await relocateJetStreamStore(logger);
    } catch (err) {
      errorOutput(`failed to relocate JetStream store: ${stringifyError(err)}`);
      process.exit(1);
    }
  }

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
      // Single-line JSON for `--json` parseability — pretty-printing
      // would split across lines that don't individually parse. Exit
      // nonzero on failure so callers that key on exit code see it.
      console.log(
        JSON.stringify({ ran: result.ran, skipped: result.skipped, failed: result.failed }),
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
};

async function handleList(argv: MigrateArgs): Promise<void> {
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
    const records = await listMigrationRecords(nc);
    const byId = new Map(records.map((r) => [r.id, r]));
    const entries = migrations.map((m) => ({
      id: m.id,
      name: m.name,
      description: m.description,
      record: byId.get(m.id) ?? null,
    }));
    if (argv.json) {
      console.log(JSON.stringify({ migrations: entries }));
      return;
    }
    printList(entries);
  } finally {
    await cleanup();
  }
}

/**
 * Cheap probe of the daemon's /health endpoint. 500ms timeout is enough
 * on localhost; failure modes (DNS, connection refused, timeout) all
 * fall through to "no daemon" — the safe default. The KV lock in
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
