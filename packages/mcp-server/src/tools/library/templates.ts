import { z } from "zod/v4";
import type { ToolHandler } from "../types.ts";
import { createSuccessResponse } from "../types.ts";
import { fetchWithTimeout, handleDaemonResponse } from "../utils.ts";

export const libraryTemplatesTool: ToolHandler = {
  name: "library_templates",
  description: "List available content generation templates through daemon API",
  inputSchema: z.object({}),
  handler: async (_, { daemonUrl, logger }) => {
    logger.info("MCP library_templates called");

    try {
      const response = await fetchWithTimeout(`${daemonUrl}/api/library/templates`);
      const templates = await handleDaemonResponse(response, "library_templates", logger);

      logger.info("MCP library_templates response", {
        templateCount: templates.length,
      });

      return createSuccessResponse({
        templates,
        total: templates.length,
        source: "daemon_api",
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error("MCP library_templates failed", { error });
      throw error;
    }
  },
};
