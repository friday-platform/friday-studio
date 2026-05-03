import { stringifyError } from "@atlas/utils";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { ToolContext } from "../types.ts";
import { createErrorResponse, createSuccessResponse } from "../utils.ts";
import { lookupStateEntry } from "./storage.ts";

/** Register MCP tool for looking up entries in persistent workspace state */
export function registerStateLookupTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "state_lookup",
    {
      description:
        "Check if an entry exists in persistent workspace state (JetStream-backed). " +
        "Searches entries by field name and value. " +
        "Returns the matching entry if found.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace ID"),
        workspaceName: z.string().optional().describe("Human-readable workspace name"),
        key: z
          .string()
          .min(1)
          .max(100)
          .regex(/^[a-z][a-z0-9_-]*$/)
          .describe("State key (table-like prefix)"),
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
    async ({ workspaceId, workspaceName, key, field, value }): Promise<CallToolResult> => {
      ctx.logger.info("MCP state_lookup called", { workspaceId, workspaceName, key, field });

      try {
        const entry = await lookupStateEntry(workspaceId, key, field, value);
        if (entry) return createSuccessResponse({ found: true, entry });
        return createSuccessResponse({ found: false });
      } catch (error) {
        ctx.logger.error("state_lookup failed", { error, workspaceId, key });
        return createErrorResponse("Failed to lookup state", stringifyError(error));
      }
    },
  );
}
