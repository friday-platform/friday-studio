import { z } from "zod";
import type { ToolContext } from "../types.ts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createSuccessResponse } from "../types.ts";
import { fetchWithTimeout, handleDaemonResponse } from "../utils.ts";

export function registerDraftValidateTool(server: McpServer, ctx: ToolContext) {
  server.registerTool(
    "atlas:workspace_draft_validate",
    {
      description:
        "Validate workspace draft configuration for correctness, completeness, and best practices. Returns detailed validation results and suggestions.",
      inputSchema: {
        draftId: z.string().min(1).describe(
          "Unique identifier of the draft to validate",
        ),
      },
    },
    async ({ draftId }) => {
      ctx.logger.info("MCP workspace_draft_validate called", { draftId });

      try {
        const response = await fetchWithTimeout(
          `${ctx.daemonUrl}/api/drafts/${draftId}/validate`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
          },
        );

        const result = await handleDaemonResponse(response, "workspace_draft_validate", ctx.logger);

        ctx.logger.info("MCP workspace_draft_validate response", {
          success: result.success,
          draftId,
          valid: result.valid,
          errorCount: result.errors?.length || 0,
        });

        return createSuccessResponse({
          ...result,
          source: "daemon_api",
          timestamp: new Date().toISOString(),
        });
      } catch (error) {
        ctx.logger.error("MCP workspace_draft_validate failed", { draftId, error });
        throw error;
      }
    },
  );
}
