/**
 * Workspace persistence tool for MCP server
 * Toggles workspace persistence (ephemeral <-> persistent) via the daemon API
 */
import { client, parseResult } from "@atlas/client/v2";
import { stringifyError } from "@atlas/utils";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ToolContext } from "../types.ts";
import { createErrorResponse, createSuccessResponse } from "../utils.ts";

export function registerWorkspacePersistenceTool(server: McpServer, ctx: ToolContext) {
  server.registerTool(
    "workspace_set_persistence",
    {
      description:
        "Toggle workspace persistence. Set persistent=true to promote an ephemeral workspace to persistent; set persistent=false to convert a persistent workspace to ephemeral.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace ID to update (obtain from workspace_list)"),
        persistent: z
          .boolean()
          .describe("Target persistence state: true for persistent, false for ephemeral"),
      },
    },
    async ({ workspaceId, persistent }) => {
      ctx.logger.info("MCP workspace_set_persistence called", { workspaceId, persistent });
      const response = await parseResult(
        client.workspace[":workspaceId"].persistence.$post({
          param: { workspaceId },
          json: { persistent },
        }),
      );

      if (!response.ok) {
        ctx.logger.error("Failed to set workspace persistence", {
          workspaceId,
          error: response.error,
        });
        return createErrorResponse(
          `Failed to set persistence for workspace '${workspaceId}': ${stringifyError(response.error)}`,
        );
      }

      return createSuccessResponse({ workspace: response.data, source: "daemon_api" });
    },
  );
}
