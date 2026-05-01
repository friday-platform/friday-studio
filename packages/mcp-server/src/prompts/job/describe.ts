/**
 * Job describe prompt for MCP server
 * Describes a specific job within a workspace through the daemon API
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { PromptContext } from "../types.ts";
import { createSuccessResponse } from "../types.ts";

export function registerJobDescribePrompt(server: McpServer, ctx: PromptContext) {
  server.registerPrompt(
    "job_describe",
    {
      title: "Describe Job",
      description:
        "Get detailed information about a specific job including its configuration, execution strategy, agent assignments, trigger conditions, and execution history. Useful for understanding job workflows and debugging execution issues.",
      argsSchema: {
        workspaceId: z.string().describe("Workspace ID containing the job"),
        jobId: z.string().describe("Job ID to describe"),
      },
    },
    ({ workspaceId, jobId }) => {
      ctx.logger.info("MCP workspace_jobs_describe called", { workspaceId, jobId });

      return createSuccessResponse(
        `Return detailed information about the job with ID ${jobId} in workspace ${workspaceId}. Use markdown syntax to format the response.`,
      );
    },
  );
}
