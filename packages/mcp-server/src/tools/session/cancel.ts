/**
 * Session cancel tool for MCP server
 * Terminates active execution sessions through the daemon API
 */

import { z } from "zod/v4";
import type { ToolHandler } from "../types.ts";
import { createSuccessResponse } from "../types.ts";

export const sessionCancelTool: ToolHandler = {
  name: "session_cancel",
  description:
    "Terminate an active execution session gracefully across all workspaces. This is a global operation that searches for the session ID across all active workspaces and stops the running job while cleaning up associated resources. Use this when a session needs to be stopped due to errors, changed requirements, or resource constraints.",
  inputSchema: z.object({
    sessionId: z.string().describe(
      "Unique identifier of the active session to terminate (can be from any workspace)",
    ),
  }),
  handler: async ({ sessionId }, { daemonUrl, logger }) => {
    logger.info("MCP session_cancel called", { sessionId });

    try {
      const response = await fetch(`${daemonUrl}/api/sessions/${sessionId}`, {
        method: "DELETE",
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(
          `Daemon API error: ${response.status} - ${errorData.error || response.statusText}`,
        );
      }

      const result = await response.json();

      return createSuccessResponse({
        success: true,
        sessionId,
        message: result.message,
        source: "daemon_api",
      });
    } catch (error) {
      logger.error("MCP session_cancel failed", { sessionId, error });
      throw error;
    }
  },
};
