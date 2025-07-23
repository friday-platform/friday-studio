import { z } from "zod/v4";
import type { ToolContext } from "../types.ts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createSuccessResponse } from "../types.ts";
import { fetchWithTimeout, handleDaemonResponse } from "../utils.ts";

export function registerDraftListTool(server: McpServer, ctx: ToolContext) {
  server.registerTool(
    "atlas_list_session_drafts",
    {
      description:
        "List all workspace drafts for the current session or conversation context. Shows draft status, creation times, and basic metadata.",
      inputSchema: {
        sessionId: z.string().optional().describe(
          "Session ID to list drafts for (optional, defaults to current session)",
        ),
        conversationId: z.string().optional().describe(
          "Conversation ID to list drafts for (optional, used for conversation-scoped drafts)",
        ),
        includeDetails: z.boolean().default(false).describe(
          "Whether to include detailed configuration summaries for each draft",
        ),
      },
    },
    async ({ sessionId, conversationId, includeDetails = false }) => {
      ctx.logger.info("MCP list_session_drafts called", {
        sessionId,
        conversationId,
        includeDetails,
      });

      try {
        const params = new URLSearchParams();
        if (sessionId) params.set("sessionId", sessionId);
        if (conversationId) params.set("conversationId", conversationId);
        if (includeDetails) params.set("includeDetails", "true");

        const queryString = params.toString();
        const url = queryString
          ? `${ctx.daemonUrl}/api/drafts?${queryString}`
          : `${ctx.daemonUrl}/api/drafts`;

        const response = await fetchWithTimeout(url);

        const result = await handleDaemonResponse(response, "list_session_drafts", ctx.logger);

        ctx.logger.info("MCP list_session_drafts response", {
          success: result.success,
          totalDrafts: result.total,
          includeDetails,
        });

        return createSuccessResponse({
          ...result,
          source: "daemon_api",
          timestamp: new Date().toISOString(),
        });
      } catch (error) {
        ctx.logger.error("MCP list_session_drafts failed", { error });
        throw error;
      }
    },
  );
}
