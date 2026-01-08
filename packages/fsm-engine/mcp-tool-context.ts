/**
 * MCP Tool Provider for FSM Engine
 *
 * Provides interface for fetching MCP tools for use in FSM LLM actions.
 * Follows the same pattern as AgentContextBuilder.fetchAllTools().
 */

import type { AtlasTool } from "@atlas/agent-sdk";
import type { MCPServerConfig } from "@atlas/config";
import type { GlobalMCPServerPool } from "@atlas/core";
import type { Logger } from "@atlas/logger";
import { getAtlasDaemonUrl } from "@atlas/oapi-client";
import { MCPManager } from "@atlas/mcp";

/**
 * Platform tools exposed to FSM LLM steps.
 * Minimal set - runs without per-invocation user consent.
 */
const PLATFORM_TOOL_ALLOWLIST = new Set([
  "webfetch",
  "artifacts_create",
  "artifacts_get",
  "artifacts_update",
]);

/** All platform tool names (superset, for filtering) */
const PLATFORM_TOOL_NAMES = new Set([
  // Filesystem tools (require explicit MCP config)
  "fs_glob",
  "fs_grep",
  "fs_list_files",
  "fs_read_file",
  "fs_write_file",
  // System tools (require explicit config)
  "bash",
  "csv",
  // Artifact tools
  "artifacts_create",
  "artifacts_get",
  "artifacts_update",
  "artifacts_get_by_chat",
  // Library tools (require explicit config)
  "library_list",
  "library_get",
  "library_get_stream",
  "library_store",
  "library_stats",
  "library_templates",
  // System info
  "system_version",
  // Web fetch (allowed)
  "webfetch",
  // Workspace conversion (allowed - needed for do_task workflow)
  "convert_task_to_workspace",
]);

/**
 * Provider interface for fetching MCP tools
 * Abstracts MCP infrastructure from FSMEngine
 */
export interface MCPToolProvider {
  /**
   * Fetch tools from MCP servers by server IDs
   * @param serverIds Array of MCP server IDs to fetch tools from
   * @returns Promise<Record<string, AtlasTool>> Tools indexed by name
   */
  getToolsForServers(serverIds: string[]): Promise<Record<string, AtlasTool>>;
}

/**
 * Implementation using GlobalMCPServerPool
 * Follows same pattern as AgentContextBuilder.fetchAllTools()
 */
export class GlobalMCPToolProvider implements MCPToolProvider {
  constructor(
    private mcpServerPool: GlobalMCPServerPool,
    private workspaceId: string,
    private mcpServerConfigs: Record<string, MCPServerConfig>,
    private logger: Logger,
  ) {}

  async getToolsForServers(serverIds: string[]): Promise<Record<string, AtlasTool>> {
    // Always include atlas-platform for ambient capabilities
    const daemonUrl = getAtlasDaemonUrl();
    const platformConfig: MCPServerConfig = {
      transport: { type: "http", url: `${daemonUrl}/mcp` },
    };

    const effectiveConfigs: Record<string, MCPServerConfig> = { "atlas-platform": platformConfig };

    // Add explicitly requested servers (skip atlas-platform if re-requested)
    for (const [id, config] of Object.entries(this.mcpServerConfigs)) {
      if (serverIds.includes(id) && id !== "atlas-platform") {
        effectiveConfigs[id] = config;
      }
    }

    const effectiveServerIds = Object.keys(effectiveConfigs);

    this.logger.debug("Acquiring MCP manager from pool", {
      workspaceId: this.workspaceId,
      serverIds: effectiveServerIds,
    });

    let mcpManager: MCPManager;
    try {
      mcpManager = await this.mcpServerPool.getMCPManager(effectiveConfigs);
    } catch (error) {
      this.logger.error("Failed to acquire MCP manager for platform tools", {
        workspaceId: this.workspaceId,
        daemonUrl,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }

    try {
      const tools = await mcpManager.getToolsForServers(effectiveServerIds);

      // Filter: platform tools must be in allowlist, others pass through
      const filteredTools = Object.fromEntries(
        Object.entries(tools).filter(([name]) => {
          const isPlatformTool = PLATFORM_TOOL_NAMES.has(name) || name.startsWith("atlas_");
          return !isPlatformTool || PLATFORM_TOOL_ALLOWLIST.has(name);
        }),
      );

      this.logger.debug("Fetched and filtered MCP tools", {
        workspaceId: this.workspaceId,
        rawToolCount: Object.keys(tools).length,
        filteredToolCount: Object.keys(filteredTools).length,
        allowedPlatformTools: Object.keys(filteredTools).filter((n) =>
          PLATFORM_TOOL_ALLOWLIST.has(n),
        ),
      });

      return filteredTools;
    } finally {
      this.mcpServerPool.releaseMCPManager(effectiveConfigs);
    }
  }
}
