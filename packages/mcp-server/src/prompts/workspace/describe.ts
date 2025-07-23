/**
 * Workspace describe prompt for MCP server
 * Describes a specific workspace through the daemon API
 */

import { z } from "zod/v4";
import type { PromptContext } from "../types.ts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createSuccessResponse } from "../types.ts";

export function registerWorkspaceDescribePrompt(
  server: McpServer,
  ctx: PromptContext,
) {
  server.registerPrompt(
    "workspace_describe",
    {
      title: "Describe Workspace",
      description:
        "Get detailed information about a specific workspace including its configuration, agents, jobs, signals, status, and operational metrics. Provides comprehensive overview of workspace components and their relationships.",
      argsSchema: {
        workspaceId: z.string().describe("Workspace ID to describe"),
      },
    },
    ({ workspaceId }) => {
      ctx.logger.info("MCP workspace_describe called", { workspaceId });

      return createSuccessResponse(
        `Return detailed information about the workspace with ID ${workspaceId}. Use markdown syntax to format the response.`,
      );
    },
  );
}
