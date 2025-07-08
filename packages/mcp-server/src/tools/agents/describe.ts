/**
 * Agents describe tool for MCP server
 * Retrieves detailed information about a specific agent through the daemon API
 */

import { z } from "zod";
import type { ToolContext } from "../types.ts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createSuccessResponse } from "../types.ts";

export function registerAgentsDescribeTool(server: McpServer, ctx: ToolContext) {
  server.registerTool(
    "atlas:workspace_agents_describe",
    {
      description: "Get detailed information about a specific agent through daemon API",
      inputSchema: {
        workspaceId: z.string().describe("Workspace ID"),
        agentId: z.string().describe("Agent ID to describe"),
      },
    },
    async ({ workspaceId, agentId }) => {
      ctx.logger.info("MCP workspace_agents_describe called", { workspaceId, agentId });

      try {
        const response = await fetch(
          `${ctx.daemonUrl}/api/workspaces/${workspaceId}/agents/${agentId}`,
        );
        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          throw new Error(
            `Daemon API error: ${response.status} - ${errorData.error || response.statusText}`,
          );
        }

        const agent = await response.json();

        return createSuccessResponse({
          agent,
          workspaceId,
          source: "daemon_api",
        });
      } catch (error) {
        ctx.logger.error("MCP workspace_agents_describe failed", {
          workspaceId,
          agentId,
          error,
        });
        throw error;
      }
    },
  );
}
