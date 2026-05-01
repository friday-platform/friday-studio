/**
 * Workspace delete tool for MCP server
 * Removes workspaces through the daemon API
 */

import { client, parseResult } from "@atlas/client/v2";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ToolContext } from "../types.ts";
import { createErrorResponse, createSuccessResponse } from "../utils.ts";

export function registerWorkspaceDeleteTool(server: McpServer, ctx: ToolContext) {
  server.registerTool(
    "workspace_delete",
    {
      description:
        "Remove a workspace and its associated resources permanently. This action destroys the workspace environment, its configuration, and all associated data. Use with caution as this operation cannot be undone.",
      inputSchema: {
        workspaceId: z
          .string()
          .describe("Unique identifier of the workspace to permanently remove from the system"),
        force: z
          .boolean()
          .default(false)
          .describe(
            "Bypass safety checks and force deletion even if workspace has active sessions or running jobs",
          ),
      },
    },
    async ({ workspaceId, force }) => {
      ctx.logger.info("MCP workspace_delete called", { workspaceId, force });

      const result = await parseResult(
        client.workspace[":workspaceId"].$delete({
          param: { workspaceId },
          query: force ? { force: "true" } : {},
        }),
      );
      if (!result.ok) {
        ctx.logger.error("Failed to delete workspace", { workspaceId, error: result.error });
        return createErrorResponse(`Failed to delete workspace '${workspaceId}': ${result.error}`);
      }

      ctx.logger.info("Workspace deleted via daemon API", { workspaceId });

      return createSuccessResponse({
        success: true,
        workspaceId,
        message: result.data.message,
        source: "daemon_api",
      });
    },
  );
}
