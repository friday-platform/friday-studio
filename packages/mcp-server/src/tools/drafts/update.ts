import { z } from "zod";
import type { ToolContext } from "../types.ts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createSuccessResponse } from "../types.ts";
import { fetchWithTimeout, handleDaemonResponse } from "../utils.ts";

export function registerDraftUpdateTool(server: McpServer, ctx: ToolContext) {
  server.registerTool(
    "atlas:workspace_draft_update",
    {
      description:
        "Update an existing workspace draft with configuration changes and validation. Supports iterative development with helpful error reporting.",
      inputSchema: {
        draftId: z.string().min(1).describe(
          "Unique identifier of the draft to update (obtain from workspace_draft_create or list_session_drafts)",
        ),
        updates: z.record(z.string(), z.unknown()).describe(
          "Configuration updates to apply to the draft (partial WorkspaceConfig)",
        ),
        updateDescription: z.string().optional().describe(
          "Optional description of what changes are being made",
        ),
      },
    },
    async ({ draftId, updates, updateDescription }) => {
      ctx.logger.info("MCP workspace_draft_update called", { draftId, updateDescription });

      try {
        const response = await fetchWithTimeout(`${ctx.daemonUrl}/api/drafts/${draftId}`, {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            updates,
            updateDescription,
          }),
        });

        const result = await handleDaemonResponse(response, "workspace_draft_update", ctx.logger);

        ctx.logger.info("MCP workspace_draft_update response", {
          success: result.success,
          draftId,
          validation: result.validation?.valid,
        });

        return createSuccessResponse({
          ...result,
          source: "daemon_api",
          timestamp: new Date().toISOString(),
        });
      } catch (error) {
        ctx.logger.error("MCP workspace_draft_update failed", { draftId, error });
        throw error;
      }
    },
  );
}
