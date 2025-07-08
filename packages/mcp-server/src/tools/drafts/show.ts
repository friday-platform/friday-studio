import { z } from "zod";
import type { ToolContext } from "../types.ts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createSuccessResponse } from "../types.ts";
import { fetchWithTimeout, handleDaemonResponse } from "../utils.ts";

export function registerDraftShowTool(server: McpServer, ctx: ToolContext) {
  server.registerTool(
    "atlas:show_draft_config",
    {
      description:
        "Display current workspace draft configuration with clear formatting. Shows the complete configuration structure and current values.",
      inputSchema: {
        draftId: z.string().min(1).describe(
          "Unique identifier of the draft to display",
        ),
        format: z.enum(["yaml", "json", "summary"]).default("yaml").describe(
          "Format for displaying the configuration (yaml, json, or human-readable summary)",
        ),
      },
    },
    async ({ draftId, format = "yaml" }) => {
      ctx.logger.info("MCP show_draft_config called", { draftId, format });

      try {
        const response = await fetchWithTimeout(
          `${ctx.daemonUrl}/api/drafts/${draftId}?format=${format}`,
        );

        const result = await handleDaemonResponse(response, "show_draft_config", ctx.logger);

        ctx.logger.info("MCP show_draft_config response", {
          success: result.success,
          draftId,
          format: result.format,
        });

        return createSuccessResponse({
          ...result,
          source: "daemon_api",
          timestamp: new Date().toISOString(),
        });
      } catch (error) {
        ctx.logger.error("MCP show_draft_config failed", { draftId, error });
        throw error;
      }
    },
  );
}
