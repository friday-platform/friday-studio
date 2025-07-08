/**
 * Signals trigger tool for MCP server
 * Triggers workspace signals through the daemon API
 */

import { z } from "zod/v4";
import type { ToolHandler } from "../types.ts";
import { createSuccessResponse } from "../types.ts";
import { checkWorkspaceMCPEnabled } from "../utils.ts";

export const signalsTriggerTool: ToolHandler = {
  name: "workspace_signals_trigger",
  description:
    "Trigger a workspace signal to start automated job execution. Signals route to specific jobs based on payload conditions and create execution sessions that run asynchronously. Sessions contain the actual job progress and results.",
  inputSchema: z.object({
    workspaceId: z.string().describe("Workspace ID"),
    signalName: z.string().describe("Signal name to trigger"),
    payload: z.record(z.string(), z.unknown()).optional().describe(
      "Signal payload data used for job routing and agent input",
    ),
  }),
  handler: async ({ workspaceId, signalName, payload }, { daemonUrl, logger }) => {
    logger.info("MCP workspace_signals_trigger called", { workspaceId, signalName });

    // SECURITY: Check if workspace has MCP enabled
    const mcpEnabled = await checkWorkspaceMCPEnabled(daemonUrl, workspaceId, logger);
    if (!mcpEnabled) {
      logger.warn("Platform MCP: Blocked workspace operation - MCP disabled", {
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
        `${daemonUrl}/api/workspaces/${workspaceId}/signals/${signalName}`,
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
      logger.error("MCP workspace_signals_trigger failed", {
        workspaceId,
        signalName,
        error,
      });
      throw error;
    }
  },
};
