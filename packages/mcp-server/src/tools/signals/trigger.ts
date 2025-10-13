/**
 * Signals trigger tool for MCP server
 * Triggers workspace signals through the daemon API
 */

import { client, parseResult } from "@atlas/client/v2";
import { stringifyError } from "@atlas/utils";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ToolContext } from "../types.ts";
import { createErrorResponse, createSuccessResponse } from "../utils.ts";

// Not registred for now, as we trigger workspaces via direct job execution
// This tool still can be usful for asyc job execution.
export function registerSignalsTriggerTool(server: McpServer, ctx: ToolContext) {
  server.registerTool(
    "atlas_workspace_signals_trigger",
    {
      description:
        "Trigger a workspace signal to start automated job execution. Signals route to specific jobs based on payload conditions and create execution sessions that run asynchronously. Sessions contain the actual job progress and results.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace ID"),
        signalName: z.string().describe("Signal name to trigger"),
        streamId: z.string().describe("SSE Stream ID for result streaming"),
        payload: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Signal payload data used for job routing and agent input"),
      },
    },
    async ({ workspaceId, signalName, payload, streamId }) => {
      ctx.logger.info("MCP workspace_signals_trigger called", { workspaceId, signalName });
      const response = await parseResult(
        client.workspace[":workspaceId"].signals[":signalId"].$post({
          param: { workspaceId, signalId: signalName },
          json: { payload, streamId },
        }),
      );

      if (!response.ok) {
        return createErrorResponse(
          `Failed to list signals for workspace '${workspaceId}': ${stringifyError(response.error)}`,
        );
      }

      return createSuccessResponse({
        success: true,
        workspaceId,
        signalName,
        streamId,
        status: response.data.status,
        message: response.data.message,
        source: "daemon_api",
      });
    },
  );
}
