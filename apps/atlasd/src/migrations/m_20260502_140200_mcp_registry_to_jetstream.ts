/**
 * Migration: legacy `~/.atlas/mcp-registry.db` (Deno KV) → JetStream KV
 * (`MCP_REGISTRY` bucket).
 *
 * Step 1 of the Deno KV consolidation. Smallest blast radius (single
 * consumer, well-defined CAS surface). Validates the framework
 * end-to-end against real on-disk data before the larger surfaces
 * (cron, workspace registry, scratchpad, artifacts) move.
 *
 * Idempotent: each entry checks for an existing JS KV key before
 * re-writing. The legacy SQLite file is left in place by this entry —
 * the final cleanup migration (`drop-legacy-storage-db`) deletes it
 * once all five Deno KV migrations have shipped. The legacy
 * `core/kv.ts` + `storage/deno-kv-storage.ts` adapters were deleted in
 * the same wave; this migration reads SQLite directly via `Deno.openKv`.
 *
 * No-op if the legacy file doesn't exist (fresh install).
 */

import { join } from "node:path";
import type { MCPServerMetadata } from "@atlas/core/mcp-registry/schemas";
import { MCP_REGISTRY_BUCKET } from "@atlas/core/mcp-registry/storage";
import { stringifyError } from "@atlas/utils";
import { getFridayHome } from "@atlas/utils/paths.server";
import { enc, type Migration, readKvJson } from "jetstream";

const KV_PREFIX = ["mcp_registry"] as const;

export const migration: Migration = {
  id: "20260502_140200_mcp_registry_to_jetstream",
  name: "MCP registry → JetStream KV",
  description:
    "Walk ~/.atlas/mcp-registry.db (Deno KV) and republish each entry into " +
    "the MCP_REGISTRY JetStream KV bucket. Skips entries whose JS KV key " +
    "already exists. Legacy SQLite file is left in place; the final cleanup " +
    "migration deletes it.",
  async run({ js, logger }) {
    const legacyPath = join(getFridayHome(), "mcp-registry.db");

    // Bail early if the legacy file isn't there — fresh install or
    // already cleaned up.
    try {
      await Deno.stat(legacyPath);
    } catch {
      logger.debug("Legacy mcp-registry.db not present — nothing to migrate", { path: legacyPath });
      return;
    }
    const denoKv: Deno.Kv = await Deno.openKv(legacyPath);

    try {
      const targetKv = await js.kv.getOrCreate(MCP_REGISTRY_BUCKET, { history: 5 });

      let migrated = 0;
      let skipped = 0;
      let failed = 0;

      const iter = denoKv.list<MCPServerMetadata>({ prefix: [...KV_PREFIX] });
      for await (const entry of iter) {
        const value = entry.value;
        if (!value || typeof value !== "object" || !("id" in value)) {
          // Malformed legacy row — log and skip.
          logger.warn("Skipping malformed legacy MCP registry row", { key: entry.key });
          failed++;
          continue;
        }
        const id = value.id;

        // Idempotent: skip if the JS KV bucket already holds this entry.
        const existing = await readKvJson<MCPServerMetadata>(targetKv, id);
        if (existing) {
          skipped++;
          continue;
        }

        try {
          await targetKv.create(id, enc.encode(JSON.stringify(value)));
          migrated++;
        } catch (err) {
          // create() throws on race (concurrent writer beat us). Treat
          // as "already there" and move on — the read above just missed
          // the race window.
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes("wrong last sequence") || msg.includes("exists")) {
            skipped++;
          } else {
            logger.warn("Failed to migrate MCP registry entry", { id, error: stringifyError(err) });
            failed++;
          }
        }
      }

      logger.info("MCP registry migration complete", { migrated, skipped, failed });
    } finally {
      denoKv.close();
    }
  },
};
