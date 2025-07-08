/**
 * Jobs list tool for MCP server
 * Lists available jobs within a workspace through the daemon API
 */

import { z } from "zod/v4";
import type { ToolHandler } from "../types.ts";
import { createSuccessResponse } from "../types.ts";
import { checkJobDiscoverable, checkWorkspaceMCPEnabled } from "../utils.ts";

export const jobsListTool: ToolHandler = {
  name: "workspace_jobs_list",
  description:
    "Discover all automated tasks (jobs) available within a specific workspace. Jobs represent reusable workflows that can be triggered to perform operations like builds, deployments, data processing, or custom automation. Only shows jobs marked as discoverable.",
  inputSchema: z.object({
    workspaceId: z.string().describe(
      "Unique identifier of the workspace whose jobs you want to explore",
    ),
  }),
  handler: async ({ workspaceId }, { daemonUrl, logger }) => {
    logger.info("MCP workspace_jobs_list called", { workspaceId });

    // SECURITY: Check if workspace has MCP enabled
    const mcpEnabled = await checkWorkspaceMCPEnabled(daemonUrl, workspaceId, logger);
    if (!mcpEnabled) {
      logger.warn("Platform MCP: Blocked workspace operation - MCP disabled", {
        workspaceId,
        operation: "workspace_jobs_list",
      });
      // Use MCP standard error code for authorization failure
      const error = new Error(
        `MCP is disabled for workspace '${workspaceId}'. Enable it in workspace.yml server.mcp.enabled to access workspace capabilities.`,
      );
      // deno-lint-ignore no-explicit-any
      (error as any).code = -32000; // MCP server error code for authorization
      throw error;
    }

    try {
      const response = await fetch(`${daemonUrl}/api/workspaces/${workspaceId}/jobs`);
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(
          `Daemon API error: ${response.status} - ${errorData.error || response.statusText}`,
        );
      }

      const allJobs = await response.json();

      // Filter jobs based on discoverability settings
      const discoverableJobs = [];
      for (const job of allJobs) {
        const isDiscoverable = await checkJobDiscoverable(daemonUrl, workspaceId, job.name, logger);
        if (isDiscoverable) {
          discoverableJobs.push(job);
        }
      }

      logger.info("MCP workspace_jobs_list filtered results", {
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
      logger.error("MCP workspace_jobs_list failed", { workspaceId, error });
      throw error;
    }
  },
};
