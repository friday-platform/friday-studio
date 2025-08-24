/**
 * Signals trigger tool for MCP server
 * Triggers workspace signals through the daemon API
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ToolContext } from "../types.ts";
import { createSuccessResponse } from "../types.ts";

export function registerSignalsDescribeTool(server: McpServer, ctx: ToolContext) {
  server.registerTool(
    "atlas_workspace_signals_describe",
    {
      description:
        "Describe a workspace signal. Signals route to specific jobs based on payload conditions and create execution sessions that run asynchronously. Sessions contain the actual job progress and results.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace ID"),
        signalName: z.string().describe("Signal name to describe"),
      },
    },
    async ({ workspaceId, signalName }) => {
      ctx.logger.info("MCP workspace_signals_describe called", { workspaceId, signalName });

      try {
        const response = await fetch(
          `${ctx.daemonUrl}/api/workspaces/${workspaceId}/signals/${signalName}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload || {}),
          },
        );

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          throw new Error(
            `Daemon API error: ${response.status} - ${errorData.error || response.statusText}`,
          );
        }

        const result = await response.json();

        return createSuccessResponse({
          success: true,
          workspaceId,
          signalName,
          status: result.status,
          message: result.message,
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
