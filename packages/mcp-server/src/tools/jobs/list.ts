/**
 * Jobs list tool for MCP server
 * Lists available jobs within a workspace through the daemon API
 */

import { client, parseResult } from "@atlas/client/v2";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ToolContext } from "../types.ts";
import { createErrorResponse, createSuccessResponse } from "../utils.ts";

export function registerJobsListTool(server: McpServer, ctx: ToolContext) {
  server.registerTool(
    "atlas_workspace_jobs_list",
    {
      description:
        "Discover all automated tasks (jobs) available within a specific workspace. Jobs represent reusable workflows that can be triggered to perform operations like builds, deployments, data processing, or custom automation. Only shows jobs marked as discoverable.",
      inputSchema: {
        workspaceId: z
          .string()
          .describe("Unique identifier of the workspace whose jobs you want to explore"),
      },
    },
    async ({ workspaceId }) => {
      ctx.logger.info("MCP workspace_jobs_list called", { workspaceId });

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

      ctx.logger.info("MCP workspace_jobs_list filtered results", {
        workspaceId,
        totalJobs: jobs.length,
      });

      return createSuccessResponse({
        jobs,
        total: jobs.length,
        workspaceId,
        source: "daemon_api",
        filtered: true, // Indicate that jobs were filtered for discoverability
      });
    },
  );
}
