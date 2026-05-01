/**
 * Agents list tool for MCP server
 * Lists available agents within a workspace through the daemon API
 */

import { client, parseResult } from "@atlas/client/v2";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ToolContext } from "../types.ts";
import { createErrorResponse, createSuccessResponse } from "../utils.ts";

export function registerAgentsListTool(server: McpServer, ctx: ToolContext) {
  server.registerTool(
    "workspace_agents_list",
    {
      description: "List all agents in a workspace through daemon API",
      inputSchema: { workspaceId: z.string().describe("Workspace ID to list agents for") },
    },
    async ({ workspaceId }) => {
      ctx.logger.info("MCP workspace_agents_list called", { workspaceId });

      const result = await parseResult(
        client.workspace[":workspaceId"].agents.$get({ param: { workspaceId } }),
      );
      if (!result.ok) {
        ctx.logger.error("Failed to list agents", { workspaceId, error: result.error });
        return createErrorResponse(
          `Failed to list agents for workspace '${workspaceId}': ${result.error}`,
        );
      }
      const agents = result.data;

      return createSuccessResponse({
        agents,
        total: agents.length,
        workspaceId,
        source: "daemon_api",
      });
    },
  );
}
