/**
 * Atlas Workspace Tools - AI SDK Compatible
 */

import { z } from "zod/v4";
import { tool } from "ai";
import {
  defaultContext,
  fetchWithTimeout,
  getErrorMessage,
  handleDaemonResponse,
} from "../utils.ts";

export const workspaceTools = {
  atlas_workspace_list: tool({
    description: "Lists all available Atlas workspaces with their basic information.",
    inputSchema: z.object({}),
    execute: async () => {
      try {
        const response = await fetchWithTimeout(`${defaultContext.daemonUrl}/api/workspaces`);
        const workspaces = await handleDaemonResponse(response);
        return { workspaces };
      } catch (error) {
        throw new Error(`Failed to list workspaces: ${getErrorMessage(error)}`);
      }
    },
  }),

  atlas_workspace_create: tool({
    description: "Creates a new workspace with optional template and custom configuration.",
    inputSchema: z.object({
      name: z.string().describe("The name of the workspace"),
      description: z.string().optional().describe("Description of the workspace"),
      template: z.string().optional().describe("Template to use for workspace creation"),
      config: z.record(z.string(), z.unknown()).optional().describe("Custom configuration object"),
    }),
    execute: async ({ name, description, template, config }) => {
      try {
        const response = await fetchWithTimeout(`${defaultContext.daemonUrl}/api/workspaces`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, description, template, config }),
        });
        const workspace = await handleDaemonResponse(response);
        return { workspace };
      } catch (error) {
        throw new Error(`Failed to create workspace: ${getErrorMessage(error)}`);
      }
    },
  }),

  atlas_workspace_delete: tool({
    description: "Removes a workspace with safety checks and optional force deletion.",
    inputSchema: z.object({
      workspaceId: z.string().describe("The ID of the workspace to delete"),
      force: z.boolean().optional().describe("Force deletion without confirmation"),
    }),
    execute: async ({ workspaceId, force }) => {
      try {
        const url = `${defaultContext.daemonUrl}/api/workspaces/${workspaceId}${
          force ? "?force=true" : ""
        }`;
        const response = await fetchWithTimeout(url, { method: "DELETE" });
        await handleDaemonResponse(response);
        return { success: true, workspaceId };
      } catch (error) {
        throw new Error(`Failed to delete workspace: ${getErrorMessage(error)}`);
      }
    },
  }),

  atlas_workspace_describe: tool({
    description:
      "Gets comprehensive workspace details including configuration, status, active sessions, agents, jobs, and resource usage. Essential for understanding workspace state.",
    inputSchema: z.object({
      workspaceId: z.string().describe("The ID of the workspace to describe"),
    }),
    execute: async ({ workspaceId }) => {
      try {
        const response = await fetchWithTimeout(
          `${defaultContext.daemonUrl}/api/workspaces/${workspaceId}`,
        );
        const workspace = await handleDaemonResponse(response);
        return { workspace };
      } catch (error) {
        throw new Error(`Failed to describe workspace: ${getErrorMessage(error)}`);
      }
    },
  }),
};
