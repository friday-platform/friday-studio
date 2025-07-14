/**
 * Workspace list prompt for MCP server
 * Lists available workspaces through the daemon API
 */

import { z } from "zod";
import type { PromptContext } from "../types.ts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createSuccessResponse } from "../types.ts";

export function registerWorkspaceListPrompt(
  server: McpServer,
  ctx: PromptContext,
) {
  server.registerPrompt(
    "workspace_list",
    {
      title: "List Workspaces",
      description:
        "View all available workspaces in the Atlas platform including their configurations, status, and metadata. Workspaces are isolated environments containing agents, jobs, signals, and other components that work together to automate tasks.",
      argsSchema: {
        status: z
          .string()
          .optional()
          .describe("Filter by workspace status (active, inactive, etc.)"),
        limit: z
          .string()
          .optional()
          .describe("Maximum number of workspaces to return"),
      },
    },
    ({ status, limit }) => {
      ctx.logger.info("MCP workspace_list called", { status, limit });

      const statusFilter = status ? ` with status ${status}` : "";
      const limitFilter = limit ? ` (limit ${limit} results)` : "";
      return createSuccessResponse(
        `Return a list of workspaces matching the status: ${statusFilter} with a limit of ${limitFilter}. Use markdown syntax to format the response.`,
      );
    },
  );
}
