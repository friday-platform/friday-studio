/**
 * Workspace describe tool for MCP server
 * Retrieves detailed information about Atlas workspaces through the daemon API
 */

import { z } from "zod/v4";
import type { ToolHandler } from "../types.ts";
import { createSuccessResponse } from "../types.ts";

export const workspaceDescribeTool: ToolHandler = {
  name: "workspace_describe",
  description:
    "Retrieve comprehensive details about a specific Atlas workspace including its configuration, status, active sessions, and available resources. Use this to understand a workspace's current state and capabilities.",
  inputSchema: z.object({
    workspaceId: z.string().describe(
      "Unique identifier of the workspace to examine (obtain from workspace_list)",
    ),
  }),
  handler: async ({ workspaceId }, { daemonUrl, logger }) => {
    logger.info("MCP workspace_describe called", { workspaceId });

    try {
      const response = await fetch(`${daemonUrl}/api/workspaces/${workspaceId}`);
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(
          `Daemon API error: ${response.status} - ${errorData.error || response.statusText}`,
        );
      }

      const workspace = await response.json();

      logger.info("Workspace described via daemon API", {
        workspaceId,
        hasActiveRuntime: workspace.hasActiveRuntime,
      });

      return createSuccessResponse({
        ...workspace,
        source: "daemon_api",
        queryTime: new Date().toISOString(),
      });
    } catch (error) {
      logger.error("MCP workspace_describe failed", { workspaceId, error });
      throw error;
    }
  },
};
