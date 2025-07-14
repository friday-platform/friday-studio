/**
 * Library search prompt for MCP server
 * Searches library items within a workspace through the daemon API
 */

import { z } from "zod";
import type { PromptContext } from "../types.ts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createSuccessResponse } from "../types.ts";

export function registerLibrarySearchPrompt(
  server: McpServer,
  ctx: PromptContext,
) {
  server.registerPrompt(
    "library_search",
    {
      title: "Search Library",
      description:
        "Search across all library items within a workspace using flexible queries. Supports searching by content, metadata, tags, and other attributes to find relevant reports, sessions, templates, and artifacts.",
      argsSchema: {
        workspaceId: z.string().describe("Workspace ID to search within"),
        query: z.string().describe("Search query to find library items"),
        category: z.string().optional().describe("Filter results by category"),
        limit: z
          .string()
          .optional()
          .describe("Maximum number of results to return"),
      },
    },
    ({ workspaceId, query, category, limit }) => {
      ctx.logger.info("MCP library_search called", {
        workspaceId,
        query,
        category,
        limit,
      });

      const categoryFilter = category ? ` in category ${category}` : "";
      const limitFilter = limit ? ` (limit ${limit} results)` : "";
      return createSuccessResponse(
        `Search for library items matching "${query}"${categoryFilter} in workspace ${workspaceId} with a limit of ${limitFilter}. Use markdown syntax to format the response.`,
      );
    },
  );
}
