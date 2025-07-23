/**
 * Workspace list tool for MCP server
 * Discovers available Atlas workspaces through the daemon API
 */

import { z } from "zod";
import type { ToolContext } from "../types.ts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createSuccessResponse } from "../types.ts";

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

      try {
        const response = await fetch(`${ctx.daemonUrl}/api/workspaces`);
        if (!response.ok) {
          throw new Error(`Daemon API error: ${response.status} ${response.statusText}`);
        }

        const workspaces = await response.json();

        ctx.logger.info("MCP workspace_list response", {
          totalWorkspaces: workspaces.length,
          // deno-lint-ignore no-explicit-any
          runningWorkspaces: workspaces.filter((w: any) => w.status === "running").length,
        });

        return createSuccessResponse({
          workspaces,
          total: workspaces.length,
          source: "daemon_api",
          timestamp: new Date().toISOString(),
        });
      } catch (error) {
        ctx.logger.error("MCP workspace_list failed", { error });
        throw error;
      }
    },
  );
}
