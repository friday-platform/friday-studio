/**
 * Library get prompt for MCP server
 * Retrieves a specific library item within a workspace through the daemon API
 */

import { z } from "zod/v4";
import type { PromptContext } from "../types.ts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createSuccessResponse } from "../types.ts";

export function registerLibraryGetPrompt(
  server: McpServer,
  ctx: PromptContext,
) {
  server.registerPrompt(
    "library_get",
    {
      title: "Get Library Item",
      description:
        "Retrieve the full content of a specific library item including its metadata, content, and associated resources. Useful for accessing reports, session data, templates, and other workspace artifacts.",
      argsSchema: {
        workspaceId: z
          .string()
          .describe("Workspace ID containing the library item"),
        itemId: z.string().describe("Library item ID to retrieve"),
      },
    },
    ({ workspaceId, itemId }) => {
      ctx.logger.info("MCP library_get called", { workspaceId, itemId });

      return createSuccessResponse(
        `Return the full content of library item with ID ${itemId} from workspace ${workspaceId}. Use markdown syntax to format the response.`,
      );
    },
  );
}
