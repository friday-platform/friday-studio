import { stringifyError } from "@atlas/utils";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { ToolContext } from "../types.ts";
import { createErrorResponse, createSuccessResponse } from "../utils.ts";
import { filterStateValues } from "./storage.ts";

/** Register MCP tool for filtering values against persistent workspace state */
export function registerStateFilterTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "state_filter",
    {
      description:
        "Filter an array of values against persistent workspace state (JetStream-backed). " +
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
          .describe("State key (table-like prefix)"),
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
        const result = await filterStateValues(workspaceId, key, field, values);
        return createSuccessResponse(result);
      } catch (error) {
        ctx.logger.error("state_filter failed", { error, workspaceId, key });
        return createErrorResponse("Failed to filter state", stringifyError(error));
      }
    },
  );
}
