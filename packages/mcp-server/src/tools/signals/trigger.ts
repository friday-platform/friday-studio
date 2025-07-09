/**
 * Signals trigger tool for MCP server
 * Triggers workspace signals through the daemon API
 */

import { z } from "zod";
import type { ToolContext } from "../types.ts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createSuccessResponse } from "../types.ts";
import { checkWorkspaceMCPEnabled } from "../utils.ts";

export function registerSignalsTriggerTool(server: McpServer, ctx: ToolContext) {
  server.registerTool(
    "atlas_workspace_signals_trigger",
    {
      description:
        "Trigger a workspace signal to start automated job execution. Signals route to specific jobs based on payload conditions and create execution sessions that run asynchronously. Sessions contain the actual job progress and results.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace ID"),
        signalName: z.string().describe("Signal name to trigger"),
        payload: z.record(z.string(), z.unknown()).optional().describe(
          "Signal payload data used for job routing and agent input",
        ),
      },
    },
    async ({ workspaceId, signalName, payload }) => {
      ctx.logger.info("MCP workspace_signals_trigger called", { workspaceId, signalName });

      // SECURITY: Check if workspace has MCP enabled
      const mcpEnabled = await checkWorkspaceMCPEnabled(ctx.daemonUrl, workspaceId, ctx.logger);
      if (!mcpEnabled) {
        ctx.logger.warn("Platform MCP: Blocked workspace operation - MCP disabled", {
          workspaceId,
          operation: "workspace_signals_trigger",
        });
        const error = new Error(
          `MCP is disabled for workspace '${workspaceId}'. Enable it in workspace.yml server.mcp.enabled to access workspace capabilities.`,
        );
        // deno-lint-ignore no-explicit-any
        (error as any).code = -32000;
        throw error;
      }

      try {
        const response = await fetch(
          `${ctx.daemonUrl}/api/workspaces/${workspaceId}/signals/${signalName}`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
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
