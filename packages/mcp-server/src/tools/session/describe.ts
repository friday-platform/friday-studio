/**
 * Session describe tool for MCP server
 * Retrieves detailed information about execution sessions through the daemon API
 */

import { client, parseResult } from "@atlas/client/v2";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ToolContext } from "../types.ts";
import { createErrorResponse, createSuccessResponse } from "../utils.ts";

export function registerSessionDescribeTool(server: McpServer, ctx: ToolContext) {
  server.registerTool(
    "atlas_session_describe",
    {
      description:
        "Examine a specific execution session across all workspaces to understand its current state, progress, logs, and results. This is a global operation that searches for the session ID across all active workspaces in the system. Sessions track the complete lifecycle of job executions, including their inputs, outputs, and any errors encountered.",
      inputSchema: {
        sessionId: z
          .string()
          .describe(
            "Unique identifier of the session to examine (obtain from workspace_sessions_list or other session listings)",
          ),
      },
    },
    async ({ sessionId }) => {
      ctx.logger.info("MCP session_describe called", { sessionId });

      const response = await parseResult(client.sessions[":id"].$get({ param: { id: sessionId } }));
      if (!response.ok) {
        ctx.logger.error("Failed to describe session", { sessionId, error: response.error });
        return createErrorResponse(`Failed to get session '${sessionId}': ${response.error}`);
      }
      const session = response.data;

      return createSuccessResponse({ session, source: "daemon_api" });
    },
  );
}
