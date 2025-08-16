import { z } from "zod";
import type { ToolContext } from "../types.ts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createSuccessResponse } from "../types.ts";
import { fetchWithTimeout, handleDaemonResponse } from "../utils.ts";

export function registerLibraryGetTool(server: McpServer, ctx: ToolContext) {
  server.registerTool(
    "atlas_library_get",
    {
      description:
        "Retrieve a specific library item including its metadata and optionally its full content. Use this to access stored reports, session archives, templates, or other resources by their unique identifier.",
      inputSchema: {
        itemId: z.string().describe(
          "Unique identifier of the library item to retrieve (obtain from library_list)",
        ),
        includeContent: z.boolean().default(false).describe(
          "Whether to include the full content/data of the item, not just metadata (useful for reports, documents, or archived results)",
        ),
      },
    },
    async ({ itemId, includeContent = false }) => {
      ctx.logger.info("MCP library_get called", { itemId, includeContent });

      // Input validation
      if (!itemId || typeof itemId !== "string" || itemId.trim().length === 0) {
        throw new Error("itemId is required and must be a non-empty string");
      }

      try {
        const params = new URLSearchParams();
        if (includeContent) params.set("content", "true");

        const queryString = params.toString();
        const url = queryString
          ? `${ctx.daemonUrl}/api/library/${itemId}?${queryString}`
          : `${ctx.daemonUrl}/api/library/${itemId}`;

        const response = await fetchWithTimeout(url);
        const result = await handleDaemonResponse(response, "library_get", ctx.logger);

        ctx.logger.info("MCP library_get response", {
          itemId,
          hasContent: includeContent && "content" in result,
        });

        return createSuccessResponse({
          ...result,
          source: "daemon_api",
          timestamp: new Date().toISOString(),
        });
      } catch (error) {
        ctx.logger.error("MCP library_get failed", {
          itemId,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },
  );
}
