/**
 * Agent describe prompt for MCP server
 * Describes a specific agent within a workspace through the daemon API
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { PromptContext } from "../types.ts";
import { createSuccessResponse } from "../types.ts";

export function registerSignalTriggerPrompt(server: McpServer, ctx: PromptContext) {
  server.registerPrompt(
    "signal_trigger",
    {
      title: "Trigger Signal",
      description: "Trigger a specific signal in a workspace.",
      argsSchema: {
        workspaceId: z.string().describe("Workspace ID containing the signal"),
        signalId: z.string().describe("Signal ID to describe"),
        input: z.string().optional().describe("Input to the signal"),
      },
    },
    ({ workspaceId, signalId, input }) => {
      ctx.logger.info("MCP workspace_signals_describe called", { workspaceId, signalId });

      return createSuccessResponse(
        `Use the \`atlas_workspace_signals_trigger\` to trigger a signal. The signal ID is ${signalId}, the workspace id is ${workspaceId} and the input is ${input}. Use markdown syntax to format the response.`,
      );
    },
  );
}
