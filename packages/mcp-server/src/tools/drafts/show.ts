import { z } from "zod/v4";
import type { ToolHandler } from "../types.ts";
import { createSuccessResponse } from "../types.ts";
import { fetchWithTimeout, handleDaemonResponse } from "../utils.ts";

export const draftShowTool: ToolHandler = {
  name: "show_draft_config",
  description:
    "Display current workspace draft configuration with clear formatting. Shows the complete configuration structure and current values.",
  inputSchema: z.object({
    draftId: z.string().min(1).describe(
      "Unique identifier of the draft to display",
    ),
    format: z.enum(["yaml", "json", "summary"]).default("yaml").describe(
      "Format for displaying the configuration (yaml, json, or human-readable summary)",
    ),
  }),
  handler: async ({ draftId, format = "yaml" }, { daemonUrl, logger }) => {
    logger.info("MCP show_draft_config called", { draftId, format });

    try {
      const response = await fetchWithTimeout(
        `${daemonUrl}/api/drafts/${draftId}?format=${format}`,
      );

      const result = await handleDaemonResponse(response, "show_draft_config", logger);

      logger.info("MCP show_draft_config response", {
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
      logger.error("MCP show_draft_config failed", { draftId, error });
      throw error;
    }
  },
};
