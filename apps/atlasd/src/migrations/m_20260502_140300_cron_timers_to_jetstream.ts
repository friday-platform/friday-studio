/**
 * Migration: legacy `~/.atlas/storage.db` cron rows → JetStream KV
 * (`CRON_TIMERS` bucket).
 *
 * Step 2 of the Deno KV consolidation. CronManager already abstracts
 * its storage behind the `KVStorage` interface, so the swap is just
 * "republish each `["cron_timers", <timerKey>]` value into the new
 * bucket under key `cron_timers/<timerKey>`."
 *
 * Idempotent: skips entries whose JS KV key already exists. The legacy
 * cron rows in `storage.db` are left in place — the final cleanup
 * migration deletes the whole `storage.db` file once all five Deno KV
 * consolidation steps have shipped.
 *
 * No-op if `storage.db` doesn't exist (fresh install).
 */

import { join } from "node:path";
import { createJetStreamKVStorage } from "@atlas/storage";
import { stringifyError } from "@atlas/utils";
import { getFridayHome } from "@atlas/utils/paths.server";
import type { Migration } from "jetstream";

interface CronTimerEntry {
  workspaceId: string;
  signalId: string;
  schedule: string;
  timezone: string;
  nextExecution: string;
  lastExecution?: string;
  paused?: boolean;
}

const KV_PREFIX = ["cron_timers"] as const;
const TARGET_BUCKET = "CRON_TIMERS";

export const migration: Migration = {
  id: "20260502_140300_cron_timers_to_jetstream",
  name: "cron timers → JetStream KV",
  description:
    "Walk ~/.atlas/storage.db cron rows and republish each entry into " +
    "the CRON_TIMERS JetStream KV bucket via the JetStreamKVStorage " +
    "interface (which handles JS-KV-illegal-char encoding for keys " +
    "like 'aged_dill:auto-sweep'). Skips entries whose JS KV key " +
    "already exists. Legacy SQLite rows left in place — the final " +
    "cleanup migration deletes the whole storage.db file.",
  async run({ nc, logger }) {
    const legacyPath = join(getFridayHome(), "storage.db");

    try {
      await Deno.stat(legacyPath);
    } catch {
      logger.debug("Legacy storage.db not present — nothing to migrate", { path: legacyPath });
      return;
    }
    const denoKv: Deno.Kv = await Deno.openKv(legacyPath);

    try {
      // Go through the same JetStreamKVStorage adapter that CronManager
      // uses at runtime. This guarantees the migration writes keys in
      // exactly the format the runtime adapter reads — no chance of
      // diverging key-encoding rules.
      const targetStorage = await createJetStreamKVStorage(nc, {
        bucket: TARGET_BUCKET,
        history: 5,
      });

      let migrated = 0;
      let skipped = 0;
      let failed = 0;

      const iter = denoKv.list<CronTimerEntry>({ prefix: [...KV_PREFIX] });
      for await (const entry of iter) {
        const value = entry.value;
        const timerKey = entry.key[entry.key.length - 1];
        if (!value || typeof value !== "object" || !timerKey || typeof timerKey !== "string") {
          logger.warn("Skipping malformed legacy cron timer row", { key: entry.key });
          failed++;
          continue;
        }

        // Idempotent: skip if the JS KV bucket already holds this entry.
        const existing = await targetStorage.get([...KV_PREFIX, timerKey]);
        if (existing) {
          skipped++;
          continue;
        }

        try {
          await targetStorage.set([...KV_PREFIX, timerKey], value);
          migrated++;
        } catch (err) {
          logger.warn("Failed to migrate cron timer entry", {
            timerKey,
            error: stringifyError(err),
          });
          failed++;
        }
      }

      logger.info("Cron timers migration complete", { migrated, skipped, failed });
    } finally {
      denoKv.close();
    }
  },
};
