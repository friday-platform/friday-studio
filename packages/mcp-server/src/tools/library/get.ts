import { createAtlasClient } from "@atlas/oapi-client";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ToolContext } from "../types.ts";
import { createErrorResponse, createSuccessResponse } from "../utils.ts";

export function registerLibraryGetTool(server: McpServer, ctx: ToolContext) {
  server.registerTool(
    "atlas_library_get",
    {
      description:
        "Retrieve a specific library item including its metadata and optionally its full content. Use this to access stored reports, session archives, templates, or other resources by their unique identifier.",
      inputSchema: {
        itemId: z
          .string()
          .describe("Unique identifier of the library item to retrieve (obtain from library_list)"),
        includeContent: z
          .boolean()
          .default(false)
          .describe(
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

      const client = createAtlasClient();
      const response = await client.GET("/api/library/{itemId}", {
        params: { path: { itemId }, query: { content: includeContent ? "true" : undefined } },
      });
      if (response.error) {
        ctx.logger.error("Failed to get library item", { itemId, error: response.error });
        return createErrorResponse(
          `Failed to get library item '${itemId}': ${response.error.error || response.response.statusText}`,
        );
      }
      const libraryItem = response.data;

      const payload = { ...libraryItem, source: "daemon_api", timestamp: new Date().toISOString() };

      ctx.logger.info("MCP library_get response", {
        itemId,
        hasContent: includeContent && libraryItem.content !== undefined,
      });

      return createSuccessResponse(payload);
    },
  );
}
