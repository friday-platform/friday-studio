/**
 * Migration: per-workspace `state.db` SQLite stores → JetStream KV.
 *
 * Walks `~/.atlas/artifacts/<wsid>/state.db` files (the legacy location
 * used by the `state_*` MCP tools — append/lookup/filter), and for each
 * workspace copies every row into a per-workspace JetStream KV bucket
 * `WS_STATE_<sanitized_wsid>` under hierarchical keys
 * `[<table>, <uuid>]`.
 *
 * Idempotent — uses the JetStream KV `_migrated_v1` marker per bucket
 * to short-circuit on re-run. Legacy SQLite files are left in place
 * for rollback; a future cleanup migration can remove them once this
 * has been live across upgrades.
 *
 * No-op if `~/.atlas/artifacts/` doesn't exist (fresh install) or
 * holds no workspaces with `state.db` files.
 */

import { join } from "node:path";
import { createJetStreamKVStorage } from "@atlas/storage";
import { stringifyError } from "@atlas/utils";
import { getFridayHome } from "@atlas/utils/paths.server";
import { Database } from "@db/sqlite";
import type { Migration } from "jetstream";
import { z } from "zod";

const SAFE_BUCKET_RE = /[^A-Za-z0-9_-]/g;
const MIGRATED_MARKER_KEY = ["_migrated_v1"];

const StateRow = z.object({ data: z.string(), _ts: z.string() });

function sanitizeBucketName(workspaceId: string): string {
  return workspaceId.replace(SAFE_BUCKET_RE, "_");
}

export const m_workspace_state_to_jetstream: Migration = {
  id: "workspace-state-to-jetstream",
  name: "workspace state.db → JetStream KV (per-workspace bucket)",
  description:
    "For each ~/.atlas/artifacts/<wsid>/state.db, open the SQLite, " +
    "enumerate user tables (excluding sqlite_*), and republish every " +
    "row into JetStream KV bucket WS_STATE_<wsid> under [<table>, <uuid>]. " +
    "Idempotent via _migrated_v1 marker key per bucket. Legacy files " +
    "left in place for rollback.",
  async run({ nc, logger }) {
    const artifactsRoot = join(getFridayHome(), "artifacts");

    let workspaceDirs: string[];
    try {
      workspaceDirs = [];
      for await (const entry of Deno.readDir(artifactsRoot)) {
        if (entry.isDirectory) workspaceDirs.push(entry.name);
      }
    } catch {
      logger.debug("No legacy artifacts dir — nothing to migrate", { path: artifactsRoot });
      return;
    }

    let totalMigrated = 0;
    let totalSkipped = 0;
    let workspacesProcessed = 0;

    for (const workspaceId of workspaceDirs) {
      const dbPath = join(artifactsRoot, workspaceId, "state.db");
      try {
        await Deno.stat(dbPath);
      } catch {
        continue; // workspace dir exists but no state.db — skip
      }

      const bucket = `WS_STATE_${sanitizeBucketName(workspaceId)}`;
      const targetStorage = await createJetStreamKVStorage(nc, { bucket, history: 1 });

      // Idempotency marker: if this bucket has already been migrated,
      // skip the whole workspace.
      const marker = await targetStorage.get<{ at: string }>(MIGRATED_MARKER_KEY);
      if (marker) {
        totalSkipped++;
        logger.debug("Workspace state already migrated", { workspaceId, bucket });
        continue;
      }

      const db = new Database(dbPath, { readonly: true });
      try {
        // Enumerate user tables (skip sqlite internals).
        const tablesStmt = db.prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
        );
        const tableRows = z.array(z.object({ name: z.string() })).parse(tablesStmt.all());
        tablesStmt.finalize();

        let migratedThisWs = 0;
        for (const { name: table } of tableRows) {
          const rowStmt = db.prepare(`SELECT data, _ts FROM "${table}"`);
          const rows = z.array(StateRow).parse(rowStmt.all());
          rowStmt.finalize();

          for (const row of rows) {
            try {
              const parsed = JSON.parse(row.data) as Record<string, unknown>;
              const stored = { ...parsed, _ts: row._ts };
              await targetStorage.set([table, crypto.randomUUID()], stored);
              migratedThisWs++;
            } catch (err) {
              logger.warn("Skipping malformed state row", {
                workspaceId,
                table,
                error: stringifyError(err),
              });
            }
          }
        }

        // Mark this bucket as migrated so the next run skips.
        await targetStorage.set(MIGRATED_MARKER_KEY, { at: new Date().toISOString() });
        totalMigrated += migratedThisWs;
        workspacesProcessed++;
        logger.info("Workspace state migrated", {
          workspaceId,
          bucket,
          rows: migratedThisWs,
          tables: tableRows.length,
        });
      } finally {
        db.close();
      }
    }

    logger.info("Workspace state migration complete", {
      workspacesProcessed,
      workspacesSkipped: totalSkipped,
      totalRows: totalMigrated,
    });
  },
};
