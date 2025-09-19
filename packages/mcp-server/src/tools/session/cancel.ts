/**
 * Session cancel tool for MCP server
 * Terminates active execution sessions through the daemon API
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ToolContext } from "../types.ts";
import { createSuccessResponse } from "../types.ts";
import { CancelSessionResponseSchema } from "../../schemas.ts";

export function registerSessionCancelTool(server: McpServer, ctx: ToolContext) {
  server.registerTool(
    "atlas_session_cancel",
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

      try {
        const response = await fetch(`${ctx.daemonUrl}/api/sessions/${sessionId}`, {
          method: "DELETE",
        });

        if (!response.ok) {
          const raw = await response.json().catch(() => null);
          const parsed = z.object({ error: z.string() }).safeParse(raw);
          const message = parsed.success ? parsed.data.error : response.statusText;
          throw new Error(`Daemon API error: ${response.status} - ${message}`);
        }

        const raw = await response.json().catch(() => null);
        const parsed = CancelSessionResponseSchema.safeParse(raw);
        if (!parsed.success) {
          throw new Error("Daemon API returned invalid cancel session response");
        }
        const result = parsed.data;

        return createSuccessResponse({
          success: true,
          sessionId,
          message: result.message,
          source: "daemon_api",
        });
      } catch (error) {
        ctx.logger.error("MCP session_cancel failed", { sessionId, error });
        throw error;
      }
    },
  );
}
