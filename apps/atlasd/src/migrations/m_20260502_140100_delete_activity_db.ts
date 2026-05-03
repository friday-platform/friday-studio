/**
 * Migration: delete the orphaned `~/.atlas/activity.db` SQLite file.
 *
 * The activity subsystem was deleted 2026-05-02 — was write-only with
 * no consumer reading the records (`/api/activity` route existed but
 * nothing in the playground or CLI fetched it). The two
 * `activityStorage.create()` call sites in runtime.ts have been
 * removed; the SQLite file remains on disk on existing installs and
 * keeps growing if the daemon never restarts.
 *
 * This migration removes the file. Idempotent — `Deno.remove` on a
 * non-existent path is caught and ignored.
 */

import { join } from "node:path";
import { getFridayHome } from "@atlas/utils/paths.server";
import type { Migration } from "jetstream";

export const migration: Migration = {
  id: "20260502_140100_delete_activity_db",
  name: "delete orphaned activity.db",
  description:
    "Remove ~/.atlas/activity.db left over from the deleted activity subsystem. " +
    "No-op if the file doesn't exist.",
  async run({ logger }) {
    const path = join(getFridayHome(), "activity.db");
    try {
      await Deno.remove(path);
      logger.info("Removed orphaned activity.db", { path });
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) {
        logger.debug("activity.db not present — nothing to remove", { path });
        return;
      }
      throw err;
    }
  },
};
