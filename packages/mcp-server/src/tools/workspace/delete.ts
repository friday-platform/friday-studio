/**
 * Workspace delete tool for MCP server
 * Removes Atlas workspaces through the daemon API
 */

import { z } from "zod";
import type { ToolContext } from "../types.ts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createSuccessResponse } from "../types.ts";

export function registerWorkspaceDeleteTool(server: McpServer, ctx: ToolContext) {
  server.registerTool(
    "atlas:workspace_delete",
    {
      description:
        "Remove an Atlas workspace and its associated resources permanently. This action destroys the workspace environment, its configuration, and all associated data. Use with caution as this operation cannot be undone.",
      inputSchema: {
        workspaceId: z.string().describe(
          "Unique identifier of the workspace to permanently remove from the system",
        ),
        force: z.boolean().default(false).describe(
          "Bypass safety checks and force deletion even if workspace has active sessions or running jobs",
        ),
      },
    },
    async ({ workspaceId, force }) => {
      ctx.logger.info("MCP workspace_delete called", { workspaceId, force });

      try {
        const url = new URL(`${ctx.daemonUrl}/api/workspaces/${workspaceId}`);
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

        ctx.logger.info("Workspace deleted via daemon API", { workspaceId });

        return createSuccessResponse({
          success: true,
          workspaceId,
          message: result.message,
          source: "daemon_api",
        });
      } catch (error) {
        ctx.logger.error("MCP workspace_delete failed", { workspaceId, error });
        throw error;
      }
    },
  );
}
