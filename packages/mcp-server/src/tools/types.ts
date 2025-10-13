/**
 * Shared types for modular MCP tools
 */

import type { MergedConfig } from "@atlas/config";
import type { Logger } from "@atlas/logger";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WorkspaceRuntime } from "../../../../src/core/workspace-runtime.ts";

/**
 * Provides access to workspace runtimes
 */
export interface WorkspaceProvider {
  getOrCreateRuntime: (id: string) => Promise<WorkspaceRuntime>;
}

export interface WorkspaceConfigProvider {
  getWorkspaceConfig: (workspaceId: string) => Promise<MergedConfig | null>;
}

/**
 * Context provided to all tool handlers
 */
export interface ToolContext {
  daemonUrl: string;
  logger: Logger;
  server: McpServer;
  workspaceProvider?: WorkspaceProvider;
}
