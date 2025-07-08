/**
 * Agents describe tool for MCP server
 * Retrieves detailed information about a specific agent through the daemon API
 */

import { z } from "zod/v4";
import type { ToolHandler } from "../types.ts";
import { createSuccessResponse } from "../types.ts";

export const agentsDescribeTool: ToolHandler = {
  name: "workspace_agents_describe",
  description: "Get detailed information about a specific agent through daemon API",
  inputSchema: z.object({
    workspaceId: z.string().describe("Workspace ID"),
    agentId: z.string().describe("Agent ID to describe"),
  }),
  handler: async ({ workspaceId, agentId }, { daemonUrl, logger }) => {
    logger.info("MCP workspace_agents_describe called", { workspaceId, agentId });

    try {
      const response = await fetch(
        `${daemonUrl}/api/workspaces/${workspaceId}/agents/${agentId}`,
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
      logger.error("MCP workspace_agents_describe failed", {
        workspaceId,
        agentId,
        error,
      });
      throw error;
    }
  },
};
