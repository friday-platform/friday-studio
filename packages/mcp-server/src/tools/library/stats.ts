import { z } from "zod/v4";
import type { ToolHandler } from "../types.ts";
import { createSuccessResponse } from "../types.ts";
import { fetchWithTimeout, handleDaemonResponse } from "../utils.ts";

const schema = z.object({});

export const libraryStatsTool: ToolHandler<typeof schema> = {
  name: "library_stats",
  description: "Get library usage statistics and analytics through daemon API",
  inputSchema: schema,
  handler: async (_, { daemonUrl, logger }) => {
    logger.info("MCP library_stats called");

    try {
      const response = await fetchWithTimeout(`${daemonUrl}/api/library/stats`);
      const result = await handleDaemonResponse(response, "library_stats", logger);

      logger.info("MCP library_stats response", {
        totalItems: result.total_items,
        totalSizeBytes: result.total_size_bytes,
        typeCount: Object.keys(result.types || {}).length,
      });

      return createSuccessResponse({
        ...result,
        source: "daemon_api",
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error("MCP library_stats failed", { error });
      throw error;
    }
  },
};
