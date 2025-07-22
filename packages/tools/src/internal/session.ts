/**
 * Atlas Session Tools - AI SDK Compatible
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
 * Session Management Tools
 *
 * Tools for managing Atlas execution sessions
 */
export const sessionTools = {
  atlas_session_cancel: tool({
    description: "Terminates active execution sessions gracefully across all workspaces.",
    parameters: z.object({
      sessionId: z.string().describe("The ID of the session to cancel"),
    }),
    execute: async ({ sessionId }) => {
      try {
        const response = await fetchWithTimeout(
          `${defaultContext.daemonUrl}/api/sessions/${sessionId}`,
          {
            method: "DELETE",
          },
        );
        await handleDaemonResponse(response);
        return { success: true, sessionId };
      } catch (error) {
        throw new Error(`Failed to cancel session: ${getErrorMessage(error)}`);
      }
    },
  }),

  atlas_session_describe: tool({
    description: "Examines session state, progress, logs, and results.",
    parameters: z.object({
      sessionId: z.string().describe("The ID of the session to describe"),
    }),
    execute: async ({ sessionId }) => {
      try {
        const response = await fetchWithTimeout(
          `${defaultContext.daemonUrl}/api/sessions/${sessionId}`,
        );
        const session = await handleDaemonResponse(response);
        return { session };
      } catch (error) {
        throw new Error(`Failed to describe session: ${getErrorMessage(error)}`);
      }
    },
  }),
};
