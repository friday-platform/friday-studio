import { z } from "zod";
import type { ToolContext } from "../types.ts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createSuccessResponse } from "../types.ts";
import { fetchWithTimeout, handleDaemonResponse } from "../utils.ts";

export function registerLibraryStatsTool(server: McpServer, ctx: ToolContext) {
  server.registerTool(
    "atlas:library_stats",
    {
      description: "Get library usage statistics and analytics through daemon API",
      inputSchema: {},
    },
    async () => {
      ctx.logger.info("MCP library_stats called");

      try {
        const response = await fetchWithTimeout(`${ctx.daemonUrl}/api/library/stats`);
        const result = await handleDaemonResponse(response, "library_stats", ctx.logger);

        ctx.logger.info("MCP library_stats response", {
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
        ctx.logger.error("MCP library_stats failed", { error });
        throw error;
      }
    },
  );
}
