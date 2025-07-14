/**
 * Agent list prompt for MCP server
 * Lists available agents within a workspace through the daemon API
 */

import { z } from "zod";
import type { PromptContext } from "../types.ts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createSuccessResponse } from "../types.ts";

export function registerAgentListPrompt(server: McpServer, ctx: PromptContext) {
  server.registerPrompt(
    "agent_list",
    {
      title: "List Agents",
      description:
        "View all agents within a workspace including their configurations, capabilities, and current status. Agents are AI-powered workers that execute tasks and coordinate with other agents in the workspace.",
      argsSchema: {
        workspaceId: z.string().describe("Workspace ID to list agents for"),
      },
    },
    ({ workspaceId }) => {
      ctx.logger.info("MCP workspace_agents_list called", { workspaceId });

      return createSuccessResponse(
        `Return a list of agents for the workspace with an ID of ${workspaceId}. Format the response as markdown table`,
      );
    },
  );
}
