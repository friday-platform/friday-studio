import { z } from "zod/v4";
import type { ToolContext } from "../types.ts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createSuccessResponse } from "../types.ts";
import { fetchWithTimeout, handleDaemonResponse } from "../utils.ts";

export function registerDraftDeleteTool(server: McpServer, ctx: ToolContext) {
  server.registerTool(
    "atlas_delete_draft_config",
    {
      description:
        "Delete a workspace draft that is no longer needed. This permanently removes the draft and its configuration from the system.",
      inputSchema: {
        draftId: z.string().min(1).describe(
          "Unique identifier of the draft to delete",
        ),
      },
    },
    async ({ draftId }) => {
      ctx.logger.info("MCP delete_draft_config called", { draftId });

      try {
        const response = await fetchWithTimeout(
          `${ctx.daemonUrl}/api/drafts/${draftId}`,
          {
            method: "DELETE",
          },
        );

        const result = await handleDaemonResponse(response, "delete_draft_config", ctx.logger);

        ctx.logger.info("MCP delete_draft_config response", {
          success: result.success,
          draftId,
        });

        return createSuccessResponse({
          ...result,
          source: "daemon_api",
          timestamp: new Date().toISOString(),
        });
      } catch (error) {
        ctx.logger.error("MCP delete_draft_config failed", { draftId, error });
        throw error;
      }
    },
  );
}
