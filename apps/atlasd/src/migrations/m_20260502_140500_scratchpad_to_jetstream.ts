/**
 * Migration: legacy `~/.atlas/storage.db` scratchpad entries → JetStream
 * KV (`SCRATCHPAD` bucket).
 *
 * Step 4 of the Deno KV consolidation. Two changes happen at once:
 *
 *   1. **Storage move**: `Deno.openKv` → JetStreamKVStorage (same
 *      adapter every other surface uses).
 *   2. **Schema upgrade**: legacy entries stored a bare string note
 *      under key `["scratchpad", <streamId>, <ms-timestamp>]`. New
 *      shape stores `{ note, ts }` under key `["scratchpad",
 *      <streamId>, <noteId>]` (uuid). Timestamp moves into the value
 *      because JS KV keys are lex-sorted (numeric ms-timestamps in
 *      keys would need zero-padding to keep stable order; in-JS sort
 *      after fetch is cheaper at scratchpad cardinality).
 *
 * Idempotent: each entry checks for an existing JS KV entry before
 * writing. Skip-if-present collision check: legacy keys are
 * `["scratchpad", streamId, "<ms>"]` — we re-key in the migration to
 * `["scratchpad", streamId, "legacy-<ms>"]` so re-runs are safe AND
 * legacy-vs-new entries are distinguishable in the bucket.
 *
 * No-op if `storage.db` doesn't exist (fresh install).
 */

import { join } from "node:path";
import { createJetStreamKVStorage } from "@atlas/storage";
import { stringifyError } from "@atlas/utils";
import { getFridayHome } from "@atlas/utils/paths.server";
import type { Migration } from "jetstream";

const KV_PREFIX = ["scratchpad"] as const;
const TARGET_BUCKET = "SCRATCHPAD";

interface StoredNote {
  note: string;
  ts: string;
}

export const migration: Migration = {
  id: "20260502_140500_scratchpad_to_jetstream",
  name: "scratchpad → JetStream KV",
  description:
    "Walk ~/.atlas/storage.db scratchpad rows and republish each into the " +
    "SCRATCHPAD JetStream KV bucket via JetStreamKVStorage. Schema upgrade: " +
    "bare-string notes become {note, ts}; timestamp moves out of the key into " +
    "the value. Legacy entries are re-keyed under `legacy-<ms>` to " +
    "distinguish from new writes. Idempotent.",
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
      const targetStorage = await createJetStreamKVStorage(nc, {
        bucket: TARGET_BUCKET,
        history: 1,
      });

      let migrated = 0;
      let skipped = 0;
      let failed = 0;

      const iter = denoKv.list<string>({ prefix: [...KV_PREFIX] });
      for await (const entry of iter) {
        const key = entry.key;
        if (key.length !== 3) {
          logger.warn("Skipping malformed scratchpad row (unexpected key shape)", { key });
          continue;
        }
        const streamId = key[1];
        const tsRaw = key[2];
        if (
          typeof streamId !== "string" ||
          (typeof tsRaw !== "number" && typeof tsRaw !== "string")
        ) {
          logger.warn("Skipping scratchpad row with invalid key segments", { key });
          continue;
        }
        const note = entry.value;
        if (typeof note !== "string") {
          logger.warn("Skipping scratchpad row with non-string value", {
            key,
            valueType: typeof note,
          });
          continue;
        }

        const tsMs = typeof tsRaw === "number" ? tsRaw : Number(tsRaw);
        if (!Number.isFinite(tsMs)) {
          logger.warn("Skipping scratchpad row with unparseable timestamp", { key, tsRaw });
          continue;
        }

        const noteId = `legacy-${tsMs}`;
        const targetKey = [...KV_PREFIX, streamId, noteId];

        const existing = await targetStorage.get(targetKey);
        if (existing) {
          skipped++;
          continue;
        }

        const stored: StoredNote = { note, ts: new Date(tsMs).toISOString() };
        try {
          await targetStorage.set(targetKey, stored);
          migrated++;
        } catch (err) {
          logger.warn("Failed to migrate scratchpad entry", {
            streamId,
            noteId,
            error: stringifyError(err),
          });
          failed++;
        }
      }

      logger.info("Scratchpad migration complete", { migrated, skipped, failed });
    } finally {
      denoKv.close();
    }
  },
};
