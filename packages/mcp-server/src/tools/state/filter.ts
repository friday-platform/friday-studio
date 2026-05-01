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

/** Register MCP tool for filtering values against persistent workspace state */
export function registerStateFilterTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "state_filter",
    {
      description:
        "Filter an array of values against persistent workspace state (SQLite-backed). " +
        "Returns only values NOT found in state — i.e., the unprocessed subset. " +
        "Single deterministic call replaces N individual lookups.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace ID (auto-injected by platform)"),
        workspaceName: z.string().optional().describe("Human-readable workspace name"),
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
          .describe("Field name to check within entries"),
        values: z
          .array(z.union([z.string(), z.number()]))
          .describe("Array of values to check — returns those NOT found in state"),
      },
    },
    async ({ workspaceId, workspaceName, key, field, values }): Promise<CallToolResult> => {
      ctx.logger.info("MCP state_filter called", {
        workspaceId,
        workspaceName,
        key,
        field,
        count: values.length,
      });

      try {
        const filePath = join(getWorkspaceFilesDir(workspaceId), "state.db");

        // No DB = nothing processed = all values are unprocessed
        try {
          await stat(filePath);
        } catch {
          return createSuccessResponse({ unprocessed: values, total: values.length, filtered: 0 });
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
            return createSuccessResponse({
              unprocessed: values,
              total: values.length,
              filtered: 0,
            });
          }

          // Single query: load all field values, then filter in-memory
          const existingValues = new Set<string>();
          const jsonPath = `$.${field}`;
          const allStmt = db.prepare(
            `SELECT json_extract(data, ?) as v FROM "${key}" WHERE json_extract(data, ?) IS NOT NULL`,
          );
          const FilterRow = z.object({ v: z.unknown() });
          const rows = z.array(FilterRow).parse(allStmt.all(jsonPath, jsonPath));
          allStmt.finalize();
          for (const row of rows) {
            existingValues.add(String(row.v));
          }

          const unprocessed = values.filter((v) => !existingValues.has(String(v)));

          return createSuccessResponse({
            unprocessed,
            total: values.length,
            filtered: values.length - unprocessed.length,
          });
        } finally {
          db.close();
        }
      } catch (error) {
        ctx.logger.error("state_filter failed", { error, workspaceId, key });
        return createErrorResponse("Failed to filter state", stringifyError(error));
      }
    },
  );
}
