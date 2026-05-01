/**
 * Session cancel tool for MCP server
 * Terminates active execution sessions through the daemon API
 */

import { client, parseResult } from "@atlas/client/v2";
import { stringifyError } from "@atlas/utils";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ToolContext } from "../types.ts";
import { createErrorResponse, createSuccessResponse } from "../utils.ts";

export function registerSessionCancelTool(server: McpServer, ctx: ToolContext) {
  server.registerTool(
    "session_cancel",
    {
      description:
        "Terminate an active execution session gracefully across all workspaces. This is a global operation that searches for the session ID across all active workspaces and stops the running job while cleaning up associated resources. Use this when a session needs to be stopped due to errors, changed requirements, or resource constraints.",
      inputSchema: {
        sessionId: z
          .string()
          .describe(
            "Unique identifier of the active session to terminate (can be from any workspace)",
          ),
      },
    },
    async ({ sessionId }) => {
      ctx.logger.info("MCP session_cancel called", { sessionId });

      const response = await parseResult(
        client.sessions[":id"].$delete({ param: { id: sessionId } }),
      );

      if (!response.ok) {
        ctx.logger.error("Failed to cancel session", { sessionId, error: response.error });
        return createErrorResponse(
          `Failed to cancel session '${sessionId}': ${stringifyError(response.error)}`,
        );
      }
      const result = response.data;
      return createSuccessResponse({
        success: true,
        sessionId,
        message: result.message,
        source: "daemon_api",
      });
    },
  );
}
