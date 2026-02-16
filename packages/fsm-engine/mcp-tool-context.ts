/**
 * MCP Tool Provider for FSM Engine
 *
 * Provides interface for fetching MCP tools for use in FSM LLM actions.
 * Follows the same pattern as AgentContextBuilder.fetchAllTools().
 */

import type { AtlasTool } from "@atlas/agent-sdk";
import { PLATFORM_TOOL_NAMES } from "@atlas/agent-sdk";
import type { MCPServerConfig } from "@atlas/config";
import type { GlobalMCPServerPool } from "@atlas/core";
import type { Logger } from "@atlas/logger";
import type { MCPManager } from "@atlas/mcp";
import { getAtlasPlatformServerConfig } from "@atlas/oapi-client";

/**
 * Platform tools exposed to FSM LLM steps.
 * Minimal set — runs without per-invocation user consent.
 */
const PLATFORM_TOOL_ALLOWLIST = new Set([
  "webfetch",
  "artifacts_create",
  "artifacts_get",
  "artifacts_update",
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
    const effectiveConfigs: Record<string, MCPServerConfig> = {
      "atlas-platform": getAtlasPlatformServerConfig(),
    };

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
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }

    try {
      const tools = await mcpManager.getToolsForServers(effectiveServerIds);

      // Filter: platform tools must be in allowlist, others pass through
      const filteredTools = Object.fromEntries(
        Object.entries(tools).filter(([name]) => {
          const isPlatformTool = PLATFORM_TOOL_NAMES.has(name);
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
