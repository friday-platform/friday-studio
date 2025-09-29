/**
 * Workspace list tool for MCP server
 * Discovers available Atlas workspaces through the daemon API
 */

import { client, parseResult } from "@atlas/client/v2";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../types.ts";
import { createErrorResponse, createSuccessResponse } from "../utils.ts";

export function registerWorkspaceListTool(server: McpServer, ctx: ToolContext) {
  server.registerTool(
    "atlas_workspace_list",
    {
      description:
        "Discover available Atlas workspaces (project environments) to understand what development contexts are accessible. Each workspace represents an isolated project environment with its own configuration, jobs, and resources.",
      inputSchema: {},
    },
    async () => {
      ctx.logger.info("MCP workspace_list called - querying daemon API");

      const result = await parseResult(client.workspace.index.$get());
      if (!result.ok) {
        ctx.logger.error("Failed to list workspaces", { error: result.error });
        return createErrorResponse(`Failed to list workspaces: ${result.error}`);
      }
      const workspaces = result.data;

      ctx.logger.info("MCP workspace_list response", {
        totalWorkspaces: workspaces.length,
        runningWorkspaces: workspaces.filter((w) => w.status === "running").length,
      });

      return createSuccessResponse({
        workspaces,
        total: workspaces.length,
        source: "daemon_api",
        timestamp: new Date().toISOString(),
      });
    },
  );
}
