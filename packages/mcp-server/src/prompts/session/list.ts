/**
 * Session list prompt for MCP server
 * Lists available sessions within a workspace through the daemon API
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { PromptContext } from "../types.ts";
import { createSuccessResponse } from "../types.ts";

export function registerSessionListPrompt(server: McpServer, ctx: PromptContext) {
  server.registerPrompt(
    "session_list",
    {
      title: "List Sessions",
      description:
        "View all sessions within a workspace including their status, execution details, and associated jobs. Sessions represent individual execution instances of jobs triggered by signals, providing isolation and traceability for workspace operations.",
      argsSchema: {
        workspaceId: z.string().describe("Workspace ID to list sessions for"),
        status: z
          .string()
          .optional()
          .describe("Filter by session status (active, completed, failed, etc.)"),
        limit: z.string().optional().describe("Maximum number of sessions to return"),
      },
    },
    ({ workspaceId, status, limit }) => {
      ctx.logger.info("MCP session_list called", { workspaceId, status, limit });

      const statusFilter = status ? ` with status ${status}` : "";
      const limitFilter = limit ? ` (limit ${limit} results)` : "";
      return createSuccessResponse(
        `Return a list of sessions${statusFilter} for the workspace with an ID of ${workspaceId} and a limit of
        ${limitFilter}. Use markdown syntax to format the response.`,
      );
    },
  );
}
