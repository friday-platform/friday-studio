import { stat } from "node:fs/promises";
import { join } from "node:path";
import { stringifyError } from "@atlas/utils";
import { getWorkspaceFilesDir } from "@atlas/utils/paths.server";
import { Database } from "@db/sqlite";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { ToolContext } from "../types.ts";
import { createErrorResponse, createSuccessResponse } from "../utils.ts";

const StateRow = z.object({ data: z.string(), _ts: z.string() });

/** Register MCP tool for looking up entries in persistent workspace state */
export function registerStateLookupTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "state_lookup",
    {
      description:
        "Check if an entry exists in persistent workspace state (SQLite-backed). " +
        "Searches entries by field name and value. " +
        "Returns the matching entry if found.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace ID"),
        key: z
          .string()
          .min(1)
          .max(100)
          .regex(/^[a-z][a-z0-9_-]*$/)
          .describe("State key (table name)"),
        field: z
          .string()
          .min(1)
          .max(100)
          .regex(/^[a-z0-9_.]+$/i)
          .describe("Field name to search within entries (alphanumeric, dots, underscores)"),
        value: z
          .union([z.string(), z.number(), z.boolean()])
          .describe("Value to match against field"),
      },
    },
    async ({ workspaceId, key, field, value }): Promise<CallToolResult> => {
      ctx.logger.info("MCP state_lookup called", { workspaceId, key, field });

      try {
        const filePath = join(getWorkspaceFilesDir(workspaceId), "state.db");

        // Check if DB exists before opening readonly connection
        try {
          await stat(filePath);
        } catch {
          return createSuccessResponse({ found: false });
        }

        const db = new Database(filePath, { readonly: true });
        try {
          db.exec("PRAGMA busy_timeout=5000");

          // Check if table exists
          const tableStmt = db.prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
          );
          const tableCheck = tableStmt.get(key);
          tableStmt.finalize();
          if (!tableCheck) {
            return createSuccessResponse({ found: false });
          }

          // Search using json_extract with direct value binding.
          // json_extract returns native SQL types: TEXT for strings, INTEGER for
          // numbers and booleans (true=1, false=0). The @db/sqlite driver maps
          // JS types to matching SQL types (string→TEXT, number→INTEGER,
          // boolean→INTEGER), so direct comparison works correctly.
          const queryStmt = db.prepare(
            `SELECT data, _ts FROM "${key}" WHERE json_extract(data, ?) = ? LIMIT 1`,
          );
          const rawRow = queryStmt.get(`$.${field}`, value);
          queryStmt.finalize();

          const row = StateRow.optional().parse(rawRow);
          if (row) {
            const parsed = z.record(z.string(), z.unknown()).parse(JSON.parse(row.data));
            parsed._ts = row._ts;
            return createSuccessResponse({ found: true, entry: parsed });
          }
          return createSuccessResponse({ found: false });
        } finally {
          db.close();
        }
      } catch (error) {
        ctx.logger.error("state_lookup failed", { error, workspaceId, key });
        return createErrorResponse("Failed to lookup state", stringifyError(error));
      }
    },
  );
}
