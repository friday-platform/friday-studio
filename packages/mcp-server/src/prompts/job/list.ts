/**
 * Job list prompt for MCP server
 * Lists available jobs within a workspace through the daemon API
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { PromptContext } from "../types.ts";
import { createSuccessResponse } from "../types.ts";

export function registerJobListPrompt(server: McpServer, ctx: PromptContext) {
  server.registerPrompt(
    "job_list",
    {
      title: "List Jobs",
      description:
        "View all jobs within a workspace including their configurations, execution strategies, and agent assignments. Jobs define workflows that are triggered by signals and orchestrate agent execution sequences.",
      argsSchema: { workspaceId: z.string().describe("Workspace ID to list jobs for") },
    },
    ({ workspaceId }) => {
      ctx.logger.info("MCP workspace_jobs_list called", { workspaceId });

      return createSuccessResponse(
        `Please return a list of jobs for the workspace with an ID of ${workspaceId}`,
      );
    },
  );
}
