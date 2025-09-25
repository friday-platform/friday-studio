/**
 * Jobs list tool for MCP server
 * Lists available jobs within a workspace through the daemon API
 */

import { logger } from "@atlas/logger";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type JobInfo, JobInfoSchema } from "../../schemas.ts";
import type { ToolContext } from "../types.ts";
import { createSuccessResponse } from "../types.ts";
import { checkJobDiscoverable } from "../utils.ts";

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

      try {
        // @FIXME: Jobs are not being properly returned from the daemon API
        const response = await fetch(`${ctx.daemonUrl}/api/workspaces/${workspaceId}/jobs`);
        logger.debug("Jobs response from daemon API for workspace", { workspaceId, response });
        if (!response.ok) {
          const raw = await response.json().catch(() => null);
          const parsed = z.object({ error: z.string() }).safeParse(raw);
          const message = parsed.success ? parsed.data.error : response.statusText;
          throw new Error(`Daemon API error: ${response.status} - ${message}`);
        }

        const rawJobs = await response.json().catch(() => null);
        const jobsResult = z.array(JobInfoSchema).safeParse(rawJobs);
        if (!jobsResult.success) {
          throw new Error("Daemon API returned invalid jobs list");
        }
        const allJobs: JobInfo[] = jobsResult.data;

        // Filter jobs based on discoverability settings
        const discoverableJobs: JobInfo[] = [];
        for (const job of allJobs) {
          const isDiscoverable = await checkJobDiscoverable(
            ctx.daemonUrl,
            workspaceId,
            job.name,
            ctx.logger,
          );
          if (isDiscoverable) {
            discoverableJobs.push(job);
          }
        }

        ctx.logger.info("MCP workspace_jobs_list filtered results", {
          workspaceId,
          totalJobs: allJobs.length,
          discoverableJobs: discoverableJobs.length,
          filteredOut: allJobs.length - discoverableJobs.length,
        });

        return createSuccessResponse({
          jobs: discoverableJobs,
          total: discoverableJobs.length,
          workspaceId,
          source: "daemon_api",
          filtered: true, // Indicate that jobs were filtered for discoverability
        });
      } catch (error) {
        ctx.logger.error("MCP workspace_jobs_list failed", { workspaceId, error });
        throw error;
      }
    },
  );
}
