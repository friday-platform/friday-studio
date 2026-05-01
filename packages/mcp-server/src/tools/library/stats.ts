import { createAtlasClient } from "@atlas/oapi-client";
import { stringifyError } from "@atlas/utils";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../types.ts";
import { createErrorResponse, createSuccessResponse } from "../utils.ts";

export function registerLibraryStatsTool(server: McpServer, ctx: ToolContext) {
  server.registerTool(
    "library_stats",
    {
      description: "Get library usage statistics and analytics through daemon API",
      inputSchema: {},
    },
    async () => {
      ctx.logger.info("MCP library_stats called");

      const client = createAtlasClient();
      const response = await client.GET("/api/library/stats");
      if (response.error) {
        ctx.logger.error("Failed to get library stats", { error: response.error });
        return createErrorResponse(
          `Failed to get library statistics: ${stringifyError(response.error)}`,
        );
      }
      const stats = response.data;

      ctx.logger.info("MCP library_stats response", {
        totalItems: stats.total_items,
        totalSizeBytes: stats.total_size_bytes,
        typeCount: Object.keys(stats.types || {}).length,
      });

      return createSuccessResponse({
        total_items: stats.total_items,
        total_size_bytes: stats.total_size_bytes,
        types: stats.types,
        source: "daemon_api",
        timestamp: new Date().toISOString(),
      });
    },
  );
}
