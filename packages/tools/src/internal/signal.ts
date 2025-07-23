/**
 * Atlas Signal Tools - AI SDK Compatible
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
 * Signal Management Tools
 *
 * Tools for managing Atlas signal configurations and triggers
 */
export const signalTools = {
  atlas_workspace_signals_list: tool({
    description: "Views signal configurations that trigger automated job executions.",
    inputSchema: z.object({
      workspaceId: z.string().describe("The ID of the workspace"),
    }),
    execute: async ({ workspaceId }) => {
      try {
        const response = await fetchWithTimeout(
          `${defaultContext.daemonUrl}/api/workspaces/${workspaceId}/signals`,
        );
        const signals = await handleDaemonResponse(response);
        return { signals };
      } catch (error) {
        throw new Error(`Failed to list signals: ${getErrorMessage(error)}`);
      }
    },
  }),

  atlas_workspace_signals_trigger: tool({
    description: "Triggers workspace signals to start automated job execution.",
    inputSchema: z.object({
      workspaceId: z.string().describe("The ID of the workspace"),
      signalName: z.string().describe("The name of the signal to trigger"),
      payload: z.record(z.string(), z.unknown()).optional().describe(
        "Optional payload data for the signal",
      ),
    }),
    execute: async ({ workspaceId, signalName, payload }) => {
      try {
        const response = await fetchWithTimeout(
          `${defaultContext.daemonUrl}/api/workspaces/${workspaceId}/signals/${signalName}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ payload }),
          },
        );
        const result = await handleDaemonResponse(response);
        return { result };
      } catch (error) {
        throw new Error(`Failed to trigger signal: ${getErrorMessage(error)}`);
      }
    },
  }),
};
