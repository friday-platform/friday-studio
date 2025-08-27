/**
 * Signals trigger tool for MCP server
 * Triggers workspace signals through the daemon API
 */

import { createAtlasClient } from "@atlas/oapi-client";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ToolContext } from "../types.ts";
import { createSuccessResponse } from "../types.ts";

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

      try {
        const client = createAtlasClient();
        const response = await client.POST("/api/workspaces/{workspaceId}/signals/{signalId}", {
          params: { path: { workspaceId, signalId: signalName } },
          body: { payload, streamId },
        });

        if (response.error) {
          throw new Error(`API error (${response.response.status}): ${response.error.error}`);
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
      } catch (error) {
        ctx.logger.error("MCP workspace_signals_trigger failed", {
          workspaceId,
          signalName,
          error,
        });
        throw error;
      }
    },
  );
}
