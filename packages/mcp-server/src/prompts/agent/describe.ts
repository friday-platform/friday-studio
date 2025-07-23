/**
 * Agent describe prompt for MCP server
 * Describes a specific agent within a workspace through the daemon API
 */

import { z } from "zod/v4";
import type { PromptContext } from "../types.ts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createSuccessResponse } from "../types.ts";

export function registerAgentDescribePrompt(
  server: McpServer,
  ctx: PromptContext,
) {
  server.registerPrompt(
    "agent_describe",
    {
      title: "Describe Agent",
      description:
        "Get detailed information about a specific agent including its configuration, purpose, available tools, system prompts, and current operational status. Useful for understanding agent capabilities and troubleshooting.",
      argsSchema: {
        workspaceId: z.string().describe("Workspace ID containing the agent"),
        agentId: z.string().describe("Agent ID to describe"),
      },
    },
    ({ workspaceId, agentId }) => {
      ctx.logger.info("MCP workspace_agents_describe called", {
        workspaceId,
        agentId,
      });

      return createSuccessResponse(
        `Return detailed information about the agent with ID ${agentId} in workspace ${workspaceId}. Use markdown syntax to format the response.`,
      );
    },
  );
}
