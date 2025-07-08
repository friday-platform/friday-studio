/**
 * Workspace list tool for MCP server
 * Discovers available Atlas workspaces through the daemon API
 */

import { z } from "zod/v4";
import type { ToolHandler } from "../types.ts";
import { createSuccessResponse } from "../types.ts";

const schema = z.object({});

export const workspaceListTool: ToolHandler<typeof schema> = {
  name: "workspace_list",
  description:
    "Discover available Atlas workspaces (project environments) to understand what development contexts are accessible. Each workspace represents an isolated project environment with its own configuration, jobs, and resources.",
  inputSchema: schema,
  handler: async (_args, { daemonUrl, logger }) => {
    logger.info("MCP workspace_list called - querying daemon API");

    try {
      const response = await fetch(`${daemonUrl}/api/workspaces`);
      if (!response.ok) {
        throw new Error(`Daemon API error: ${response.status} ${response.statusText}`);
      }

      const workspaces = await response.json();

      logger.info("MCP workspace_list response", {
        totalWorkspaces: workspaces.length,
        // deno-lint-ignore no-explicit-any
        activeRuntimes: workspaces.filter((w: any) => w.hasActiveRuntime).length,
      });

      return createSuccessResponse({
        workspaces,
        total: workspaces.length,
        source: "daemon_api",
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error("MCP workspace_list failed", { error });
      throw error;
    }
  },
};
