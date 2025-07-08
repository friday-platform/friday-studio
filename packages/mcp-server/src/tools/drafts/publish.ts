import { z } from "zod/v4";
import type { ToolHandler } from "../types.ts";
import { createSuccessResponse } from "../types.ts";
import { fetchWithTimeout, handleDaemonResponse } from "../utils.ts";

const schema = z.object({
  draftId: z.string().min(1).describe(
    "Unique identifier of the draft to publish",
  ),
  path: z.string().optional().describe(
    "Target filesystem path for workspace creation (defaults to current directory)",
  ),
  overwrite: z.boolean().default(false).describe(
    "Whether to overwrite existing workspace directory if it exists",
  ),
});

export const draftPublishTool: ToolHandler<typeof schema> = {
  name: "publish_draft_to_workspace",
  description:
    "Publish validated workspace draft to filesystem for production use. Creates workspace directory structure with configuration files and setup instructions.",
  inputSchema: schema,
  handler: async ({ draftId, path, overwrite = false }, { daemonUrl, logger }) => {
    logger.info("MCP publish_draft_to_workspace called", { draftId, path, overwrite });

    try {
      const response = await fetchWithTimeout(
        `${daemonUrl}/api/drafts/${draftId}/publish`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            path,
            overwrite,
          }),
        },
      );

      const result = await handleDaemonResponse(response, "publish_draft_to_workspace", logger);

      logger.info("MCP publish_draft_to_workspace response", {
        success: result.success,
        draftId,
        workspacePath: result.workspacePath,
      });

      return createSuccessResponse({
        ...result,
        source: "daemon_api",
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error("MCP publish_draft_to_workspace failed", { draftId, error });
      throw error;
    }
  },
};
