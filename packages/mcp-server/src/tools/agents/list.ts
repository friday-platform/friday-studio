/**
 * Agents list tool for MCP server
 * Lists available agents within a workspace through the daemon API
 */

import { z } from "zod";
import type { ToolContext } from "../types.ts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createSuccessResponse } from "../types.ts";

export function registerAgentsListTool(server: McpServer, ctx: ToolContext) {
  server.registerTool(
    "atlas_workspace_agents_list",
    {
      description: "List all agents in a workspace through daemon API",
      inputSchema: {
        workspaceId: z.string().describe("Workspace ID to list agents for"),
      },
    },
    async ({ workspaceId }) => {
      ctx.logger.info("MCP workspace_agents_list called", { workspaceId });

      try {
        const response = await fetch(`${ctx.daemonUrl}/api/workspaces/${workspaceId}/agents`);
        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          throw new Error(
            `Daemon API error: ${response.status} - ${errorData.error || response.statusText}`,
          );
        }

        const agents = await response.json();

        return createSuccessResponse({
          agents,
          total: agents.length,
          workspaceId,
          source: "daemon_api",
        });
      } catch (error) {
        ctx.logger.error("MCP workspace_agents_list failed", { workspaceId, error });
        throw error;
      }
    },
  );
}
