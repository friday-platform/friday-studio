/**
 * Workspace describe tool for MCP server
 * Retrieves detailed information about Atlas workspaces through the daemon API
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ToolContext } from "../types.ts";
import { createSuccessResponse } from "../types.ts";

export function registerWorkspaceDescribeTool(server: McpServer, ctx: ToolContext) {
  server.registerTool(
    "atlas_workspace_describe",
    {
      description:
        "Retrieve comprehensive details about a specific Atlas workspace including its configuration, status, active sessions, and available resources. Use this to understand a workspace's current state and capabilities.",
      inputSchema: {
        workspaceId: z
          .string()
          .describe("Unique identifier of the workspace to examine (obtain from workspace_list)"),
      },
    },
    async ({ workspaceId }) => {
      ctx.logger.info("MCP workspace_describe called", { workspaceId });

      const response = await fetch(`${ctx.daemonUrl}/api/workspaces/${workspaceId}`);

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        const errorMessage = errorData.error || response.statusText;

        // 404 is expected - log as info, everything else is an error
        if (response.status === 404) {
          ctx.logger.info("Workspace not found", { workspaceId, status: 404 });
        } else {
          ctx.logger.error("Workspace describe API error", {
            workspaceId,
            status: response.status,
            error: errorMessage,
          });
        }

        throw new Error(
          response.status === 404
            ? `Workspace not found: ${workspaceId}`
            : `Failed to describe workspace: ${errorMessage}`,
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
    },
  );
}
