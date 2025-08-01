/**
 * Atlas System Tools - AI SDK Compatible
 */

import { tool } from "ai";
import { getVersionInfo } from "../../../../src/utils/version.ts";
import z from "zod";
import { getErrorMessage } from "@atlas/tools/utils";

/**
 * Platform tools
 *
 * Tools for application information
 */
export const platformTools = {
  system_version: tool({
    description: "Get the current version of Atlas.",
    inputSchema: z.object({}),
    execute: () => {
      try {
        return {
          command: "version",
          description: "Get the current version of Atlas.",
          exitCode: 0,
          stdout: getVersionInfo(),
          stderr: "",
          success: true,
          truncated: false,
        };
      } catch (error) {
        throw new Error(`Failed to get version: ${getErrorMessage(error)}`);
      }
    },
  }),
};
