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
    // Filter to only requested servers
    const requestedConfigs = Object.fromEntries(
      Object.entries(this.mcpServerConfigs).filter(([id]) => serverIds.includes(id)),
    );

    if (Object.keys(requestedConfigs).length === 0) {
      this.logger.debug("No MCP servers configured for requested tools", {
        workspaceId: this.workspaceId,
        requestedServerIds: serverIds,
      });
      return {};
    }

    // Get pooled MCP manager
    this.logger.debug("Acquiring MCP manager from pool", {
      workspaceId: this.workspaceId,
      serverIds: Object.keys(requestedConfigs),
    });

    const mcpManager = await this.mcpServerPool.getMCPManager(requestedConfigs);

    try {
      // Fetch tools from servers
      const tools = await mcpManager.getToolsForServers(serverIds);

      this.logger.debug("Fetched MCP tools", {
        workspaceId: this.workspaceId,
        toolCount: Object.keys(tools).length,
        toolNames: Object.keys(tools),
      });

      return tools;
    } finally {
      // Always release manager back to pool
      this.mcpServerPool.releaseMCPManager(requestedConfigs);

      this.logger.debug("Released MCP manager back to pool", { workspaceId: this.workspaceId });
    }
  }
}
