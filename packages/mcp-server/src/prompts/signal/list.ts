/**
 * Signals list tool for MCP server
 * Lists available signals within a workspace through the daemon API
 */

import { z } from "zod/v4";
import type { PromptContext } from "../types.ts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createSuccessResponse } from "../types.ts";

export function registerSignalListPrompt(
  server: McpServer,
  ctx: PromptContext,
) {
  server.registerPrompt(
    "signal_list",
    {
      title: "List Signals",
      description:
        "View all signals within a workspace that can trigger automated job executions. Signals represent external events (webhooks, schedules, file changes) that initiate workspace operations.",
      argsSchema: {
        workspaceId: z.string().describe("Workspace ID to list signals for"),
      },
    },
    ({ workspaceId }) => {
      ctx.logger.info("MCP workspace_signals_list called", { workspaceId });

      return createSuccessResponse(
        `Return a list of signals for the workspace with an ID of ${workspaceId}`,
      );
    },
  );
}
