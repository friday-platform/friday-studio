import { createAtlasClient } from "@atlas/oapi-client";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ToolContext } from "../types.ts";
import { createErrorResponse, createSuccessResponse } from "../utils.ts";

export function registerLibraryListTool(server: McpServer, ctx: ToolContext) {
  server.registerTool(
    "library_list",
    {
      description:
        "Browse and search items stored in the Atlas library with flexible filtering and text search capabilities. The library contains reusable resources like reports, session archives, templates, and documentation. Use the query parameter for full-text search or combine filters to browse by type, tags, and date ranges.",
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe(
            "Text search query to find items by name, description, or content (max 1000 characters)",
          ),
      },
    },
    async ({ query }) => {
      const client = createAtlasClient();
      const response = await client.GET("/api/library", { params: { query: { query } } });
      if (response.error) {
        ctx.logger.error("Failed to search library", { query, error: response.error });
        return createErrorResponse(
          `Failed to search library: ${response.error.error || response.response.statusText}`,
        );
      }
      const searchResult = response.data;

      ctx.logger.info("MCP library_list response", {
        totalItems: searchResult.total,
        returnedItems: searchResult.items.length,
        tookMs: searchResult.took_ms,
      });

      return createSuccessResponse({
        items: searchResult.items,
        total: searchResult.total,
        query: searchResult.query,
        took_ms: searchResult.took_ms,
        source: "daemon_api",
        timestamp: new Date().toISOString(),
      });
    },
  );
}
