/**
 * Atlas Agent Tools - AI SDK Compatible
 */

import { z } from "zod";
import { tool } from "ai";
import {
  defaultContext,
  fetchWithTimeout,
  getErrorMessage,
  handleDaemonResponse,
} from "../utils.ts";

/**
 * Agent Management Tools
 *
 * Tools for managing Atlas agents
 */
export const agentTools = {
  atlas_workspace_agents_list: tool({
    description: "Lists all agents available in a workspace.",
    parameters: z.object({
      workspaceId: z.string().describe("The ID of the workspace"),
    }),
    execute: async ({ workspaceId }) => {
      try {
        const response = await fetchWithTimeout(
          `${defaultContext.daemonUrl}/api/workspaces/${workspaceId}/agents`,
        );
        const agents = await handleDaemonResponse(response);
        return { agents };
      } catch (error) {
        throw new Error(`Failed to list agents: ${getErrorMessage(error)}`);
      }
    },
  }),

  atlas_workspace_agents_describe: tool({
    description: "Gets detailed agent information and configuration.",
    parameters: z.object({
      workspaceId: z.string().describe("The ID of the workspace"),
      agentId: z.string().describe("The ID of the agent to describe"),
    }),
    execute: async ({ workspaceId, agentId }) => {
      try {
        const response = await fetchWithTimeout(
          `${defaultContext.daemonUrl}/api/workspaces/${workspaceId}/agents/${agentId}`,
        );
        const agent = await handleDaemonResponse(response);
        return { agent };
      } catch (error) {
        throw new Error(`Failed to describe agent: ${getErrorMessage(error)}`);
      }
    },
  }),
};
