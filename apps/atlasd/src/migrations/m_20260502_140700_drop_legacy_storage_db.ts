/**
 * Migration: delete `~/.atlas/storage.db` (and `mcp-registry.db`) after
 * the Deno KV → JetStream consolidation is complete.
 *
 * The earlier migrations in this wave (mcp-registry, cron-timers,
 * workspace-registry, scratchpad, artifacts) republish each surface's
 * legacy rows into JetStream KV / Object Store and are idempotent. After
 * they all complete, the original Deno KV files are dead weight on disk.
 *
 * This migration is the LAST one in the manifest — once it runs, no
 * future migration can read the legacy `storage.db` (because it's gone).
 * That's intentional: anything that needs legacy data must be ordered
 * before this entry. Re-running on a fresh install is a no-op (file
 * doesn't exist).
 *
 * Both `storage.db` and `mcp-registry.db` are removed because Deno KV
 * may have written sidecar `-shm` / `-wal` SQLite files alongside the
 * main DB; we sweep those too.
 */

import { stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { getFridayHome } from "@atlas/utils/paths.server";
import type { Migration } from "jetstream";

const TARGETS = ["storage.db", "mcp-registry.db"];
const SIDECAR_SUFFIXES = ["", "-shm", "-wal"];

async function tryUnlink(path: string): Promise<"deleted" | "missing" | "failed"> {
  try {
    await stat(path);
  } catch {
    return "missing";
  }
  try {
    await unlink(path);
    return "deleted";
  } catch {
    return "failed";
  }
}

export const migration: Migration = {
  id: "20260502_140700_drop_legacy_storage_db",
  name: "drop ~/.atlas/storage.db + mcp-registry.db",
  description:
    "Delete the Deno KV SQLite files (and their -shm/-wal sidecars) once all " +
    "JetStream consolidation migrations have completed. Idempotent — missing " +
    "files are skipped silently.",
  async run({ logger }) {
    const home = getFridayHome();
    const counts = { deleted: 0, missing: 0, failed: 0 };

    for (const base of TARGETS) {
      for (const suffix of SIDECAR_SUFFIXES) {
        const path = join(home, base + suffix);
        const result = await tryUnlink(path);
        counts[result]++;
        if (result === "deleted") {
          logger.info("Removed legacy KV file", { path });
        } else if (result === "failed") {
          logger.warn("Failed to remove legacy KV file", { path });
        }
      }
    }

    logger.info("Legacy storage.db cleanup complete", counts);
  },
};
