/**
 * Atlas Job Tools - AI SDK Compatible
 */

import { z } from "zod/v4";
import { tool } from "ai";
import {
  defaultContext,
  fetchWithTimeout,
  getErrorMessage,
  handleDaemonResponse,
} from "../utils.ts";

/**
 * Job Management Tools
 *
 * Tools for managing Atlas automated tasks
 */
export const jobTools = {
  atlas_workspace_jobs_list: tool({
    description: "Lists discoverable automated tasks within a workspace.",
    inputSchema: z.object({
      workspaceId: z.string().describe("The ID of the workspace"),
    }),
    execute: async ({ workspaceId }) => {
      try {
        const response = await fetchWithTimeout(
          `${defaultContext.daemonUrl}/api/workspaces/${workspaceId}/jobs`,
        );
        const jobs = await handleDaemonResponse(response);
        return { jobs };
      } catch (error) {
        throw new Error(`Failed to list jobs: ${getErrorMessage(error)}`);
      }
    },
  }),

  atlas_workspace_jobs_describe: tool({
    description: "Examines job workflow configuration including execution strategy and agents.",
    inputSchema: z.object({
      workspaceId: z.string().describe("The ID of the workspace"),
      jobName: z.string().describe("The name of the job to describe"),
    }),
    execute: async ({ workspaceId, jobName }) => {
      try {
        const response = await fetchWithTimeout(
          `${defaultContext.daemonUrl}/api/workspaces/${workspaceId}/jobs`,
        );
        const jobs = await handleDaemonResponse(response) as unknown[];
        const job = jobs.find((j) =>
          typeof j === "object" && j !== null && "name" in j &&
          (j as { name: unknown }).name === jobName
        );

        if (!job) {
          throw new Error(`Job '${jobName}' not found in workspace`);
        }

        return { job };
      } catch (error) {
        throw new Error(`Failed to describe job: ${getErrorMessage(error)}`);
      }
    },
  }),
};
