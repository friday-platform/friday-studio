import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { ArtifactStorage } from "@atlas/core/artifacts/server";
import { stringifyError } from "@atlas/utils";
import { getWorkspaceFilesDir } from "@atlas/utils/paths.server";
import { Database } from "@db/sqlite";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { ToolContext } from "../types.ts";
import { createErrorResponse, createSuccessResponse } from "../utils.ts";

/** Cache artifact IDs to skip listByWorkspace on repeat calls */
const artifactIdCache = new Map<string, string>();

const CountRow = z.object({ c: z.number() });

function dbPath(workspaceId: string): string {
  return join(getWorkspaceFilesDir(workspaceId), "state.db");
}

function ensureTable(db: Database, key: string): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS "${key}" (
      id INTEGER PRIMARY KEY,
      data TEXT NOT NULL,
      _ts TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS "idx_${key}_ts" ON "${key}" (_ts);
  `);
}

async function resolveArtifactId(workspaceId: string): Promise<string | undefined> {
  const cached = artifactIdCache.get(workspaceId);
  if (cached) return cached;

  const listResult = await ArtifactStorage.listByWorkspace({ workspaceId, includeData: false });
  if (!listResult.ok) return undefined;

  const match = listResult.data.find((a) => a.title === "workspace-state");
  if (match) {
    artifactIdCache.set(workspaceId, match.id);
    return match.id;
  }
  return undefined;
}

/** Register MCP tool for appending entries to persistent workspace state */
export function registerStateAppendTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "state_append",
    {
      description:
        "Append an entry to persistent workspace state (SQLite-backed). " +
        "A _ts timestamp is auto-added. " +
        "Optionally prune entries older than ttl_hours. " +
        "State survives across job runs and workspace restarts.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace ID"),
        key: z
          .string()
          .min(1)
          .max(100)
          .regex(/^[a-z][a-z0-9_-]*$/)
          .describe(
            "State key — becomes a table name (lowercase alphanumeric, hyphens, underscores)",
          ),
        entry: z.record(z.string(), z.unknown()).describe("JSON object to append"),
        ttl_hours: z
          .number()
          .positive()
          .optional()
          .describe("Prune entries older than this many hours"),
      },
    },
    async ({ workspaceId, key, entry, ttl_hours }): Promise<CallToolResult> => {
      ctx.logger.info("MCP state_append called", { workspaceId, key, ttl_hours });

      try {
        const dir = getWorkspaceFilesDir(workspaceId);
        await mkdir(dir, { recursive: true });

        const filePath = dbPath(workspaceId);
        const db = new Database(filePath);

        try {
          db.exec("PRAGMA journal_mode=WAL");
          db.exec("PRAGMA busy_timeout=5000");
          ensureTable(db, key);

          const ts = new Date().toISOString();
          const data = JSON.stringify(entry);

          // Append + prune in a single transaction using db.transaction()
          let pruned = 0;
          const runTx = db.transaction(() => {
            const insertStmt = db.prepare(`INSERT INTO "${key}" (data, _ts) VALUES (?, ?)`);
            insertStmt.run(data, ts);
            insertStmt.finalize();

            if (ttl_hours !== undefined) {
              const cutoff = new Date(Date.now() - ttl_hours * 3600000).toISOString();
              const countStmt = db.prepare(`SELECT COUNT(*) as c FROM "${key}" WHERE _ts < ?`);
              const countResult = CountRow.optional().parse(countStmt.get(cutoff));
              countStmt.finalize();
              pruned = countResult?.c ?? 0;

              const deleteStmt = db.prepare(`DELETE FROM "${key}" WHERE _ts < ?`);
              deleteStmt.run(cutoff);
              deleteStmt.finalize();
            }
          });
          runTx();

          const totalStmt = db.prepare(`SELECT COUNT(*) as c FROM "${key}"`);
          const totalResult = CountRow.optional().parse(totalStmt.get());
          totalStmt.finalize();
          const count = totalResult?.c ?? 0;

          // Create or update artifact for workspace-scoped discovery
          const existingId = await resolveArtifactId(workspaceId);
          const summary = `Workspace state DB (${count} entries in "${key}")`;

          if (existingId) {
            const updateResult = await ArtifactStorage.update({
              id: existingId,
              data: { type: "file", version: 1, data: { path: filePath } },
              summary,
            });
            if (!updateResult.ok) {
              // Stale cache — artifact may have been deleted externally
              artifactIdCache.delete(workspaceId);
              ctx.logger.warn("Failed to update state artifact, cache invalidated", {
                error: updateResult.error,
                key,
              });
            }
          }

          // Create if no existing artifact or update failed (cache was invalidated)
          if (!artifactIdCache.has(workspaceId)) {
            const createResult = await ArtifactStorage.create({
              data: { type: "file", version: 1, data: { path: filePath } },
              title: "workspace-state",
              summary,
              workspaceId,
            });
            if (createResult.ok) {
              artifactIdCache.set(workspaceId, createResult.data.id);
            } else {
              ctx.logger.warn("Failed to create state artifact", {
                error: createResult.error,
                key,
              });
            }
          }

          return createSuccessResponse({ count, pruned });
        } finally {
          db.close();
        }
      } catch (error) {
        ctx.logger.error("state_append failed", { error, workspaceId, key });
        return createErrorResponse("Failed to append state", stringifyError(error));
      }
    },
  );
}
