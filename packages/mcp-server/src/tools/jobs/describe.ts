/**
 * Jobs describe tool for MCP server
 * Retrieves detailed information about a specific job through the daemon API
 */

import { z } from "zod";
import type { ToolContext } from "../types.ts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createSuccessResponse } from "../types.ts";
import { checkJobDiscoverable, checkWorkspaceMCPEnabled } from "../utils.ts";

export function registerJobsDescribeTool(server: McpServer, ctx: ToolContext) {
  server.registerTool(
    "atlas_workspace_jobs_describe",
    {
      description:
        "Examine a job's workflow configuration including execution strategy (sequential, parallel, conditional), assigned agents, trigger conditions, and context provisioning. Jobs define multi-step workflows where agents receive inputs from signals, previous agents, or filesystem context, then execute using specialized MCP tools.",
      inputSchema: {
        workspaceId: z.string().describe(
          "Unique identifier of the workspace containing the job",
        ),
        jobName: z.string().describe(
          "Name of the specific job to examine (obtain from workspace_jobs_list)",
        ),
      },
    },
    async ({ workspaceId, jobName }) => {
      ctx.logger.info("MCP workspace_jobs_describe called", { workspaceId, jobName });

      // SECURITY: Check if workspace has MCP enabled
      const mcpEnabled = await checkWorkspaceMCPEnabled(ctx.daemonUrl, workspaceId, ctx.logger);
      if (!mcpEnabled) {
        ctx.logger.warn("Platform MCP: Blocked workspace operation - MCP disabled", {
          workspaceId,
          operation: "workspace_jobs_describe",
        });
        const error = new Error(
          `MCP is disabled for workspace '${workspaceId}'. Enable it in workspace.yml server.mcp.enabled to access workspace capabilities.`,
        );
        // deno-lint-ignore no-explicit-any
        (error as any).code = -32000;
        throw error;
      }

      // SECURITY: Check job discoverability
      const isDiscoverable = await checkJobDiscoverable(
        ctx.daemonUrl,
        workspaceId,
        jobName,
        ctx.logger,
      );
      if (!isDiscoverable) {
        ctx.logger.warn("Platform MCP: Blocked job access - not discoverable", {
          workspaceId,
          jobName,
        });
        const error = new Error(
          `Job '${jobName}' is not discoverable in workspace '${workspaceId}'. Add it to discoverable.jobs in workspace.yml to access job details.`,
        );
        // deno-lint-ignore no-explicit-any
        (error as any).code = -32000;
        throw error;
      }

      try {
        // Get all jobs and find the specific one
        const response = await fetch(`${ctx.daemonUrl}/api/workspaces/${workspaceId}/jobs`);
        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          throw new Error(
            `Daemon API error: ${response.status} - ${errorData.error || response.statusText}`,
          );
        }

        const jobs = await response.json();
        // deno-lint-ignore no-explicit-any
        const job = jobs.find((j: any) => j.name === jobName);

        if (!job) {
          throw new Error(`Job not found: ${jobName}`);
        }

        return createSuccessResponse({
          job,
          workspaceId,
          source: "daemon_api",
        });
      } catch (error) {
        ctx.logger.error("MCP workspace_jobs_describe failed", {
          workspaceId,
          jobName,
          error,
        });
        throw error;
      }
    },
  );
}
