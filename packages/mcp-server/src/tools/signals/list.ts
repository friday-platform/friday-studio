/**
 * Signals list tool for MCP server
 * Lists available signals within a workspace through the daemon API
 */

import { z } from "zod/v4";
import type { ToolHandler } from "../types.ts";
import { createSuccessResponse } from "../types.ts";

const schema = z.object({
  workspaceId: z.string().describe("Workspace ID to list signals for"),
});

export const signalsListTool: ToolHandler<typeof schema> = {
  name: "workspace_signals_list",
  description:
    "View all signal configurations within a workspace that can trigger automated job executions. Signals represent external events (webhooks, schedules, file changes) that initiate workspace operations.",
  inputSchema: schema,
  handler: async ({ workspaceId }, { daemonUrl, logger }) => {
    logger.info("MCP workspace_signals_list called", { workspaceId });

    try {
      const response = await fetch(`${daemonUrl}/api/workspaces/${workspaceId}/signals`);
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(
          `Daemon API error: ${response.status} - ${errorData.error || response.statusText}`,
        );
      }

      const signals = await response.json();

      return createSuccessResponse({
        signals,
        total: signals.length,
        workspaceId,
        source: "daemon_api",
      });
    } catch (error) {
      logger.error("MCP workspace_signals_list failed", { workspaceId, error });
      throw error;
    }
  },
};
