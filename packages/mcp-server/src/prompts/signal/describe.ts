/**
 * Agent describe prompt for MCP server
 * Describes a specific agent within a workspace through the daemon API
 */

import { z } from "zod";
import type { PromptContext } from "../types.ts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createSuccessResponse } from "../types.ts";

export function registerSignalDescribePrompt(
  server: McpServer,
  ctx: PromptContext,
) {
  server.registerPrompt(
    "signal_describe",
    {
      title: "Describe Signal",
      description:
        "Get detailed information about a specific signal including its configuration, purpose, available tools, system prompts, and current operational status. Useful for understanding signal capabilities and troubleshooting.",
      argsSchema: {
        workspaceId: z.string().describe("Workspace ID containing the signal"),
        signalId: z.string().describe("Signal ID to describe"),
      },
    },
    ({ workspaceId, signalId }) => {
      ctx.logger.info("MCP workspace_signals_describe called", {
        workspaceId,
        signalId,
      });

      return createSuccessResponse(
        `Return detailed information about the signal with ID ${signalId} in workspace ${workspaceId}. Use markdown syntax to format the response.`,
      );
    },
  );
}
