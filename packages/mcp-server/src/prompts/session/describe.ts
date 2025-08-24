/**
 * Session describe prompt for MCP server
 * Describes a specific session within a workspace through the daemon API
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { PromptContext } from "../types.ts";
import { createSuccessResponse } from "../types.ts";

export function registerSessionDescribePrompt(server: McpServer, ctx: PromptContext) {
  server.registerPrompt(
    "session_describe",
    {
      title: "Describe Session",
      description:
        "Get detailed information about a specific session including its execution status, agent interactions, job configuration, signal trigger details, and execution timeline. Essential for monitoring and debugging session execution.",
      argsSchema: { sessionId: z.string().describe("Session ID to describe") },
    },
    ({ sessionId }) => {
      ctx.logger.info("MCP session_describe called", { sessionId });

      return createSuccessResponse(
        `Use the \`atlas_session_describe\` tool to return detailed information about the session with ID ${sessionId}. Use markdown syntax to format the response.`,
      );
    },
  );
}
