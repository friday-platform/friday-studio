import { z } from "zod/v4";
import type { ToolHandler } from "../types.ts";
import { createSuccessResponse } from "../types.ts";
import { fetchWithTimeout, handleDaemonResponse } from "../utils.ts";

export const draftDeleteTool: ToolHandler = {
  name: "delete_draft_config",
  description:
    "Delete a workspace draft that is no longer needed. This permanently removes the draft and its configuration from the system.",
  inputSchema: z.object({
    draftId: z.string().min(1).describe(
      "Unique identifier of the draft to delete",
    ),
  }),
  handler: async ({ draftId }, { daemonUrl, logger }) => {
    logger.info("MCP delete_draft_config called", { draftId });

    try {
      const response = await fetchWithTimeout(
        `${daemonUrl}/api/drafts/${draftId}`,
        {
          method: "DELETE",
        },
      );

      const result = await handleDaemonResponse(response, "delete_draft_config", logger);

      logger.info("MCP delete_draft_config response", {
        success: result.success,
        draftId,
      });

      return createSuccessResponse({
        ...result,
        source: "daemon_api",
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error("MCP delete_draft_config failed", { draftId, error });
      throw error;
    }
  },
};
