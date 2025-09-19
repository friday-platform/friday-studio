/**
 * Agents list tool for MCP server
 * Lists available agents within a workspace through the daemon API
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ToolContext } from "../types.ts";
import { createSuccessResponse } from "../types.ts";

export function registerAgentsListTool(server: McpServer, ctx: ToolContext) {
  server.registerTool(
    "atlas_workspace_agents_list",
    {
      description: "List all agents in a workspace through daemon API",
      inputSchema: { workspaceId: z.string().describe("Workspace ID to list agents for") },
    },
    async ({ workspaceId }) => {
      ctx.logger.info("MCP workspace_agents_list called", { workspaceId });

      try {
        const response = await fetch(`${ctx.daemonUrl}/api/workspaces/${workspaceId}/agents`);
        if (!response.ok) {
          const raw = await response.json().catch(() => null);
          const parsed = z.object({ error: z.string() }).safeParse(raw);
          const message = parsed.success ? parsed.data.error : response.statusText;
          throw new Error(`Daemon API error: ${response.status} - ${message}`);
        }

        const rawAgents = await response.json().catch(() => null);
        const agentsResult = z
          .array(z.object({ id: z.string(), type: z.string(), purpose: z.string().optional() }))
          .safeParse(rawAgents);
        if (!agentsResult.success) {
          throw new Error("Daemon API returned invalid agents list");
        }
        const agents = agentsResult.data;

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
