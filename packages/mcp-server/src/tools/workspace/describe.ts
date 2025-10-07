/**
 * Workspace describe tool for MCP server
 * Retrieves detailed information about Atlas workspaces through the daemon API
 */

import { client, parseResult } from "@atlas/client/v2";
import { stringifyError } from "@atlas/utils";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ToolContext } from "../types.ts";
import { createErrorResponse, createSuccessResponse } from "../utils.ts";

export function registerWorkspaceDescribeTool(server: McpServer, ctx: ToolContext) {
  server.registerTool(
    "atlas_workspace_describe",
    {
      description:
        "Retrieve comprehensive details about a specific Atlas workspace including its configuration, status, active sessions, and available resources. Use this to understand a workspace's current state and capabilities.",
      inputSchema: {
        workspaceId: z
          .string()
          .describe("Unique identifier of the workspace to examine (obtain from workspace_list)"),
      },
    },
    async ({ workspaceId }) => {
      ctx.logger.info("MCP workspace_describe called", { workspaceId });
      const response = await parseResult(
        client.workspace[":workspaceId"].$get({ param: { workspaceId } }),
      );
      if (!response.ok) {
        ctx.logger.error("Failed to describe workspace", { workspaceId, error: response.error });
        return createErrorResponse(
          `Failed to get workspace details for '${workspaceId}': ${stringifyError(response.error)}`,
        );
      }
      const workspace = response.data;

      ctx.logger.info("Workspace described via daemon API", {
        workspaceId,
        status: workspace.status,
      });

      return createSuccessResponse({
        ...workspace,
        source: "daemon_api",
        queryTime: new Date().toISOString(),
      });
    },
  );
}
