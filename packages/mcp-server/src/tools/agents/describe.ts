/**
 * Agents describe tool for MCP server
 * Retrieves detailed information about a specific agent through the daemon API
 */

import { client, parseResult } from "@atlas/client/v2";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ToolContext } from "../types.ts";
import { createErrorResponse, createSuccessResponse } from "../utils.ts";

export function registerAgentsDescribeTool(server: McpServer, ctx: ToolContext) {
  server.registerTool(
    "atlas_workspace_agents_describe",
    {
      description: "Get detailed information about a specific agent through daemon API",
      inputSchema: {
        workspaceId: z.string().describe("Workspace ID"),
        agentId: z.string().describe("Agent ID to describe"),
      },
    },
    async ({ workspaceId, agentId }) => {
      ctx.logger.info("MCP workspace_agents_describe called", { workspaceId, agentId });

      const result = await parseResult(
        client.workspace[":workspaceId"].agents[":agentId"].$get({
          param: { workspaceId, agentId },
        }),
      );
      if (!result.ok) {
        ctx.logger.error("Failed to describe agent", { workspaceId, agentId, error: result.error });
        return createErrorResponse(
          `Failed to get agent '${agentId}' in workspace '${workspaceId}': ${result.error}`,
        );
      }
      const agent = result.data;

      return createSuccessResponse({ agent, workspaceId, source: "daemon_api" });
    },
  );
}
