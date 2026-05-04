/**
 * Shared types for modular MCP tools
 */

import type { MergedConfig } from "@atlas/config";
import type { Logger } from "@atlas/logger";
import type { WorkspaceRuntime } from "@atlas/workspace";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

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
 * Optional substrate that lets a tool handler dispatch its work over NATS
 * to a registered worker (today: in-process; future: sandboxed runner).
 * The MCP server doesn't depend on the `nats` package directly — the
 * daemon constructs and injects an implementation backed by `callTool`.
 */
export interface ToolDispatcher {
  callTool<Args, Result>(toolId: string, args: Args): Promise<Result>;
}

/**
 * Context provided to all tool handlers
 */
export interface ToolContext {
  daemonUrl: string;
  logger: Logger;
  server: McpServer;
  workspaceProvider?: WorkspaceProvider;
  /**
   * Present when the daemon has wired NATS-mediated tool dispatch. Tools
   * that have been migrated to the worker model (e.g. `bash`) use this to
   * route execution; absent → fall back to in-process execution.
   */
  toolDispatcher?: ToolDispatcher;
}
