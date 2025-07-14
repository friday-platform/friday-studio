/**
 * Library list prompt for MCP server
 * Lists available library items within a workspace through the daemon API
 */

import { z } from "zod";
import type { PromptContext } from "../types.ts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createSuccessResponse } from "../types.ts";

export function registerLibraryListPrompt(
  server: McpServer,
  ctx: PromptContext,
) {
  server.registerPrompt(
    "library_list",
    {
      title: "List Library Items",
      description:
        "View all library items within a workspace including reports, session archives, templates, and other workspace artifacts. The library serves as a knowledge base and resource repository for agents and workflows.",
      argsSchema: {
        workspaceId: z
          .string()
          .describe("Workspace ID to list library items for"),
        category: z
          .string()
          .optional()
          .describe("Filter by category (reports, sessions, templates, etc.)"),
      },
    },
    ({ workspaceId, category }) => {
      ctx.logger.info("MCP library_list called", { workspaceId, category });

      const categoryFilter = category ? ` in category ${category}` : "";
      return createSuccessResponse(
        `Return a list of library items that match the category: ${categoryFilter} for the workspace with an ID of ${workspaceId}. Use markdown syntax to format the response.`,
      );
    },
  );
}
