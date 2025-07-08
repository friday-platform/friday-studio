/**
 * Workspace delete tool for MCP server
 * Removes Atlas workspaces through the daemon API
 */

import { z } from "zod/v4";
import type { ToolHandler } from "../types.ts";
import { createSuccessResponse } from "../types.ts";

const schema = z.object({
  workspaceId: z.string().describe(
    "Unique identifier of the workspace to permanently remove from the system",
  ),
  force: z.boolean().default(false).describe(
    "Bypass safety checks and force deletion even if workspace has active sessions or running jobs",
  ),
});

export const workspaceDeleteTool: ToolHandler<typeof schema> = {
  name: "workspace_delete",
  description:
    "Remove an Atlas workspace and its associated resources permanently. This action destroys the workspace environment, its configuration, and all associated data. Use with caution as this operation cannot be undone.",
  inputSchema: schema,
  handler: async ({ workspaceId, force }, { daemonUrl, logger }) => {
    logger.info("MCP workspace_delete called", { workspaceId, force });

    try {
      const url = new URL(`${daemonUrl}/api/workspaces/${workspaceId}`);
      if (force) {
        url.searchParams.set("force", "true");
      }

      const response = await fetch(url.toString(), {
        method: "DELETE",
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(
          `Daemon API error: ${response.status} - ${errorData.error || response.statusText}`,
        );
      }

      const result = await response.json();

      logger.info("Workspace deleted via daemon API", { workspaceId });

      return createSuccessResponse({
        success: true,
        workspaceId,
        message: result.message,
        source: "daemon_api",
      });
    } catch (error) {
      logger.error("MCP workspace_delete failed", { workspaceId, error });
      throw error;
    }
  },
};
