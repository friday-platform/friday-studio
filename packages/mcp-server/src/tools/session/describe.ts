/**
 * Session describe tool for MCP server
 * Retrieves detailed information about execution sessions through the daemon API
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ToolContext } from "../types.ts";
import { createSuccessResponse } from "../types.ts";

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

      try {
        const response = await fetch(`${ctx.daemonUrl}/api/sessions/${sessionId}`);
        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          throw new Error(
            `Daemon API error: ${response.status} - ${errorData.error || response.statusText}`,
          );
        }

        const session = await response.json();

        return createSuccessResponse({ session, source: "daemon_api" });
      } catch (error) {
        ctx.logger.error("MCP session_describe failed", { sessionId, error });
        throw error;
      }
    },
  );
}
