/**
 * Migration: legacy `~/.atlas/storage.db` workspace registry rows →
 * JetStream KV (`WORKSPACE_REGISTRY` bucket).
 *
 * Step 3 of the Deno KV consolidation. The registry's data shape
 * changed in this same wave (single-key model — see
 * `RegistryStorageAdapter` docstring), so the migration also DROPS
 * the secondary structures that lived under `["workspaces", "_list"]`
 * and `["registry", *]`. They were Deno-KV-era multi-key indices that
 * JS KV's per-key model doesn't need: `_list` is replaced by a
 * `kv.list({prefix:["workspaces"]})` scan, and `registry/version` /
 * `registry/lastUpdated` had no consumers (`getRegistryStats` was
 * dead code).
 *
 * Idempotent: each per-workspace entry checks for an existing JS KV
 * key before writing. The legacy rows in `storage.db` are left in
 * place — the final cleanup migration deletes the whole file.
 *
 * No-op if `storage.db` doesn't exist (fresh install).
 */

import { join } from "node:path";
import { createJetStreamKVStorage, type KVStorage } from "@atlas/storage";
import { stringifyError } from "@atlas/utils";
import { getFridayHome } from "@atlas/utils/paths.server";
import type { Migration } from "jetstream";

const KV_PREFIX = ["workspaces"] as const;
const TARGET_BUCKET = "WORKSPACE_REGISTRY";

/**
 * Walk the registry bucket looking for an entry with `path === target`
 * but `id !== legacyId`. Returns the colliding id, or null if none.
 * Bounded by workspace cardinality (≤100 per install in practice).
 */
async function findRegistryIdByPath(
  storage: KVStorage,
  target: string,
  legacyId: string,
): Promise<string | null> {
  for await (const entry of storage.list<{ id?: unknown; path?: unknown }>([...KV_PREFIX])) {
    const value = entry.value;
    if (!value || typeof value !== "object") continue;
    if (typeof value.path !== "string" || typeof value.id !== "string") continue;
    if (value.id === legacyId) continue;
    if (value.path === target) return value.id;
  }
  return null;
}

export const migration: Migration = {
  id: "20260502_140400_workspace_registry_to_jetstream",
  name: "workspace registry → JetStream KV",
  description:
    "Walk ~/.atlas/storage.db workspace rows and republish each entry into " +
    "the WORKSPACE_REGISTRY JetStream KV bucket via the same JetStreamKVStorage " +
    "adapter the runtime uses. Drops the legacy `_list` index and " +
    "`registry/{version,lastUpdated}` meta keys (no consumers; replaced by " +
    "kv.list scan). Skips entries whose JS KV key already exists.",
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
        history: 5,
      });

      let migrated = 0;
      let skipped = 0;
      let displaced = 0;
      let failed = 0;
      let droppedIndices = 0;

      const iter = denoKv.list<unknown>({ prefix: [...KV_PREFIX] });
      for await (const entry of iter) {
        const key = entry.key;
        const value = entry.value;
        const tail = key[key.length - 1];

        // Skip the legacy `_list` index — replaced by kv.list scan.
        if (tail === "_list") {
          droppedIndices++;
          continue;
        }

        // Skip anything that doesn't look like a workspace record. A
        // workspace entry is `["workspaces", <id>]` with an object
        // value containing at minimum an `id` field.
        if (
          key.length !== 2 ||
          typeof tail !== "string" ||
          !value ||
          typeof value !== "object" ||
          !("id" in value)
        ) {
          logger.warn("Skipping non-workspace row under workspaces prefix", { key });
          continue;
        }

        const workspaceId = tail;
        const existing = await targetStorage.get([...KV_PREFIX, workspaceId]);
        if (existing) {
          skipped++;
          continue;
        }

        // Defensive path-dedupe. The legacy id is the source of truth
        // for any per-workspace data already in JetStream KV (memory,
        // cron timers, document store buckets, workspace state buckets
        // — all keyed by runtime id). If the runtime registry already
        // holds a different id pointing at this workspace's path —
        // typically a fresh id assigned by `WorkspaceManager.importExistingWorkspaces`
        // before this migration ran — replace it with the legacy id so
        // the runtime resolves to the data the rest of the migrations
        // wrote. The daemon now awaits this migration before that scan,
        // so this branch is belt-and-suspenders, but cheap and worth
        // keeping for resilience against future ordering regressions.
        const legacyPath = (value as { path?: unknown }).path;
        if (typeof legacyPath === "string") {
          const collidingId = await findRegistryIdByPath(targetStorage, legacyPath, workspaceId);
          if (collidingId) {
            try {
              await targetStorage.delete([...KV_PREFIX, collidingId]);
              displaced++;
              logger.warn(
                "Workspace already registered with a different runtime id; preserving legacy id",
                { legacyId: workspaceId, displacedId: collidingId, path: legacyPath },
              );
            } catch (err) {
              logger.warn("Failed to delete colliding workspace registry entry", {
                collidingId,
                path: legacyPath,
                error: stringifyError(err),
              });
              // Fall through — `set` below may still recover the legacy
              // id, leaving the colliding entry as a duplicate the
              // operator can clean up manually.
            }
          }
        }

        try {
          await targetStorage.set([...KV_PREFIX, workspaceId], value);
          migrated++;
        } catch (err) {
          logger.warn("Failed to migrate workspace registry entry", {
            workspaceId,
            error: stringifyError(err),
          });
          failed++;
        }
      }

      logger.info("Workspace registry migration complete", {
        migrated,
        skipped,
        displaced,
        failed,
        droppedIndices,
      });
    } finally {
      denoKv.close();
    }
  },
};
