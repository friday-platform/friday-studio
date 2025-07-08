/**
 * Agents list tool for MCP server
 * Lists available agents within a workspace through the daemon API
 */

import { z } from "zod/v4";
import type { ToolHandler } from "../types.ts";
import { createSuccessResponse } from "../types.ts";

export const agentsListTool: ToolHandler = {
  name: "workspace_agents_list",
  description: "List all agents in a workspace through daemon API",
  inputSchema: z.object({
    workspaceId: z.string().describe("Workspace ID to list agents for"),
  }),
  handler: async ({ workspaceId }, { daemonUrl, logger }) => {
    logger.info("MCP workspace_agents_list called", { workspaceId });

    try {
      const response = await fetch(`${daemonUrl}/api/workspaces/${workspaceId}/agents`);
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
      logger.error("MCP workspace_agents_list failed", { workspaceId, error });
      throw error;
    }
  },
};
