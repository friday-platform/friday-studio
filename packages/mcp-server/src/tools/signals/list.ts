/**
 * Signals list tool for MCP server
 * Lists available signals within a workspace through the daemon API
 */

import { client, parseResult } from "@atlas/client/v2";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ToolContext } from "../types.ts";
import { createErrorResponse, createSuccessResponse } from "../utils.ts";

export function registerSignalsListTool(server: McpServer, ctx: ToolContext) {
  server.registerTool(
    "atlas_workspace_signals_list",
    {
      description:
        "View all signal configurations within a workspace that can trigger automated job executions. Signals represent external events (webhooks, schedules, file changes) that initiate workspace operations.",
      inputSchema: { workspaceId: z.string().describe("Workspace ID to list signals for") },
    },
    async ({ workspaceId }) => {
      ctx.logger.info("MCP workspace_signals_list called", { workspaceId });

      const result = await parseResult(
        client.workspace[":workspaceId"].signals.$get({ param: { workspaceId } }),
      );
      if (!result.ok) {
        ctx.logger.error("Failed to list signals", { workspaceId, error: result.error });
        return createErrorResponse(
          `Failed to list signals for workspace '${workspaceId}': ${result.error}`,
        );
      }
      const signals = result.data;

      return createSuccessResponse({
        signals: signals.signals,
        total: signals.signals.length,
        workspaceId,
        source: "daemon_api",
      });
    },
  );
}
