/**
 * Workspace describe tool for MCP server
 * Retrieves detailed information about Atlas workspaces through the daemon API
 */

import { z } from "zod/v4";
import type { ToolContext } from "../types.ts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createSuccessResponse } from "../types.ts";

export function registerWorkspaceDescribeTool(server: McpServer, ctx: ToolContext) {
  server.registerTool(
    "atlas_workspace_describe",
    {
      description:
        "Retrieve comprehensive details about a specific Atlas workspace including its configuration, status, active sessions, and available resources. Use this to understand a workspace's current state and capabilities.",
      inputSchema: {
        workspaceId: z.string().describe(
          "Unique identifier of the workspace to examine (obtain from workspace_list)",
        ),
      },
    },
    async ({ workspaceId }) => {
      ctx.logger.info("MCP workspace_describe called", { workspaceId });

      try {
        const response = await fetch(`${ctx.daemonUrl}/api/workspaces/${workspaceId}`);
        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          throw new Error(
            `Daemon API error: ${response.status} - ${errorData.error || response.statusText}`,
          );
        }

        const workspace = await response.json();

        ctx.logger.info("Workspace described via daemon API", {
          workspaceId,
          status: workspace.status,
        });

        return createSuccessResponse({
          ...workspace,
          source: "daemon_api",
          queryTime: new Date().toISOString(),
        });
      } catch (error) {
        ctx.logger.error("MCP workspace_describe failed", { workspaceId, error });
        throw error;
      }
    },
  );
}
