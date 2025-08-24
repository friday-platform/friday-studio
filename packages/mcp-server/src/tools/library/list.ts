import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ToolContext } from "../types.ts";
import { createSuccessResponse } from "../types.ts";
import { buildLibraryQueryParams, fetchWithTimeout, handleDaemonResponse } from "../utils.ts";

export function registerLibraryListTool(server: McpServer, ctx: ToolContext) {
  server.registerTool(
    "atlas_library_list",
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
        type: z
          .array(z.string())
          .optional()
          .describe(
            "Specific types of library items to include (e.g., 'report', 'session_archive', 'template')",
          ),
        tags: z
          .array(z.string())
          .optional()
          .describe(
            "Category tags to filter items (e.g., 'production', 'analytics', 'development')",
          ),
        since: z
          .string()
          .optional()
          .describe(
            "Include only items created after this timestamp (ISO 8601 format, e.g., '2024-01-01T00:00:00Z')",
          ),
        until: z
          .string()
          .optional()
          .describe("Include only items created before this timestamp (ISO 8601 format)"),
        limit: z
          .number()
          .default(50)
          .describe(
            "Maximum number of items to return in this request (1-1000, useful for pagination)",
          ),
        offset: z
          .number()
          .default(0)
          .describe(
            "Number of items to skip (for pagination, use with limit to navigate through large result sets)",
          ),
      },
    },
    async ({ query, type, tags, since, until, limit = 50, offset = 0 }) => {
      ctx.logger.info("MCP library_list called", { query, type, tags, limit, offset });

      try {
        // Build query parameters using helper method
        const params = buildLibraryQueryParams({ query, type, tags, since, until, limit, offset });

        const queryString = params.toString();
        const url = queryString
          ? `${ctx.daemonUrl}/api/library?${queryString}`
          : `${ctx.daemonUrl}/api/library`;

        const response = await fetchWithTimeout(url);
        const result = await handleDaemonResponse(response, "library_list", ctx.logger);

        ctx.logger.info("MCP library_list response", {
          totalItems: result.total,
          returnedItems: result.items.length,
          tookMs: result.took_ms,
        });

        return createSuccessResponse({
          ...result,
          source: "daemon_api",
          timestamp: new Date().toISOString(),
        });
      } catch (error) {
        ctx.logger.error("MCP library_list failed", { error });
        throw error;
      }
    },
  );
}
