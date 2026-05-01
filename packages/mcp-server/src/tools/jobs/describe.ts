/**
 * Jobs describe tool for MCP server
 * Retrieves detailed information about a specific job through the daemon API
 */

import { client, parseResult } from "@atlas/client/v2";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ToolContext } from "../types.ts";
import { createErrorResponse, createSuccessResponse } from "../utils.ts";

export function registerJobsDescribeTool(server: McpServer, ctx: ToolContext) {
  server.registerTool(
    "workspace_jobs_describe",
    {
      description:
        "Examine a job's workflow configuration including execution strategy (sequential, parallel, conditional), assigned agents, trigger conditions, and context provisioning. Jobs define multi-step workflows where agents receive inputs from signals, previous agents, or filesystem context, then execute using specialized MCP tools.",
      inputSchema: {
        workspaceId: z.string().describe("Unique identifier of the workspace containing the job"),
        jobName: z
          .string()
          .describe("Name of the specific job to examine (obtain from workspace_jobs_list)"),
      },
    },
    async ({ workspaceId, jobName }) => {
      ctx.logger.info("MCP workspace_jobs_describe called", { workspaceId, jobName });

      const result = await parseResult(
        client.workspace[":workspaceId"].jobs.$get({ param: { workspaceId } }),
      );
      if (!result.ok) {
        ctx.logger.error("Failed to list jobs", { workspaceId, error: result.error });
        return createErrorResponse(
          `Failed to list jobs for workspace '${workspaceId}': ${result.error}`,
        );
      }
      const jobs = result.data;
      const job = jobs.find((j) => j.name === jobName);
      if (!job) {
        ctx.logger.error("Job not found", { workspaceId, jobName });
        return createErrorResponse(`Job '${jobName}' not found in workspace '${workspaceId}'`);
      }

      return createSuccessResponse({ job, workspaceId, source: "daemon_api" });
    },
  );
}
