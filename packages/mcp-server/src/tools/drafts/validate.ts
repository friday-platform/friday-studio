import { z } from "zod/v4";
import type { ToolHandler } from "../types.ts";
import { createSuccessResponse } from "../types.ts";
import { fetchWithTimeout, handleDaemonResponse } from "../utils.ts";

const schema = z.object({
  draftId: z.string().min(1).describe(
    "Unique identifier of the draft to validate",
  ),
});

export const draftValidateTool: ToolHandler<typeof schema> = {
  name: "workspace_draft_validate",
  description:
    "Validate workspace draft configuration for correctness, completeness, and best practices. Returns detailed validation results and suggestions.",
  inputSchema: schema,
  handler: async ({ draftId }, { daemonUrl, logger }) => {
    logger.info("MCP workspace_draft_validate called", { draftId });

    try {
      const response = await fetchWithTimeout(
        `${daemonUrl}/api/drafts/${draftId}/validate`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
        },
      );

      const result = await handleDaemonResponse(response, "workspace_draft_validate", logger);

      logger.info("MCP workspace_draft_validate response", {
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
      logger.error("MCP workspace_draft_validate failed", { draftId, error });
      throw error;
    }
  },
};
