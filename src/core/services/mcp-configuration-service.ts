/**
 * MCP Configuration Service - Provides clean interface for MCP server configuration resolution
 * Eliminates direct workspace config access from agent execution workers
 */

import { logger } from "../../utils/logger.ts";
import { LLMProviderManager } from "../agents/llm-provider-manager.ts";
import {
  type AgentConfig,
  type MCPServerOverrides,
  MCPServerRegistry,
  type SessionContext,
} from "../agents/mcp/mcp-server-registry.ts";
import { type MCPServerConfig } from "../agents/mcp/mcp-manager.ts";

/**
 * Interface for MCP configuration service
 */
export interface MCPConfigurationService {
  /**
   * Get MCP server configurations for a specific agent
   * Supports agent-specific overrides and filtering
   */
  getServerConfigsForAgent(
    agentId: string,
    requestedServerIds: string[],
    agentConfig?: AgentConfig,
  ): MCPServerConfig[];

  /**
   * Check if a server is available in the registry
   */
  isServerAvailable(serverId: string): boolean;

  /**
   * Get filtered server list based on agent permissions
   */
  getAvailableServersForAgent(agentId: string): string[];

  /**
   * Initialize MCP servers for a specific session
   */
  initializeServersForSession(
    serverIds: string[],
    sessionContext: SessionContext,
  ): Promise<void>;
}

/**
 * Workspace MCP Configuration Service Implementation
 * Provides proper encapsulation and agent-specific configuration resolution
 */
export class WorkspaceMCPConfigurationService implements MCPConfigurationService {
  constructor(
    private workspaceId: string,
    private sessionId?: string,
  ) {}

  /**
   * Get server configurations for an agent with proper resolution and filtering
   */
  getServerConfigsForAgent(
    agentId: string,
    requestedServerIds: string[],
    agentConfig?: AgentConfig,
  ): MCPServerConfig[] {
    const configs: MCPServerConfig[] = [];

    logger.debug(`Resolving MCP server configs for agent`, {
      operation: "mcp_config_resolution",
      agentId,
      requestedServerIds,
      requestedCount: requestedServerIds.length,
      workspaceId: this.workspaceId,
      sessionId: this.sessionId,
    });

    for (const serverId of requestedServerIds) {
      // Get base configuration from registry
      const baseConfig = MCPServerRegistry.getServerConfig(serverId);
      if (!baseConfig) {
        logger.warn(`MCP server not found in registry: ${serverId}`, {
          operation: "mcp_config_resolution",
          agentId,
          serverId,
          available: false,
          workspaceId: this.workspaceId,
        });
        continue;
      }

      // Apply agent-specific overrides if present
      const agentOverrides = agentConfig?.mcp_server_overrides?.[serverId];
      const finalConfig = this.applyAgentOverrides(baseConfig, agentOverrides);

      // Apply security filtering based on agent permissions
      const secureConfig = this.applySecurityFiltering(finalConfig, agentId);

      configs.push(secureConfig);

      logger.debug(`Resolved MCP server config: ${serverId}`, {
        operation: "mcp_config_resolution",
        agentId,
        serverId,
        hasOverrides: !!agentOverrides,
        finalToolCount: secureConfig.tools?.allowed?.length || 0,
        scope: secureConfig.scope,
      });
    }

    logger.debug(`Resolved ${configs.length} MCP server configs for agent`, {
      operation: "mcp_config_resolution",
      agentId,
      requestedCount: requestedServerIds.length,
      resolvedCount: configs.length,
      serverIds: configs.map((c) => c.id),
      workspaceId: this.workspaceId,
    });

    return configs;
  }

  /**
   * Check if a server is available in the registry
   */
  isServerAvailable(serverId: string): boolean {
    return MCPServerRegistry.getServerConfig(serverId) !== undefined;
  }

  /**
   * Get available servers for an agent (with potential filtering)
   */
  getAvailableServersForAgent(agentId: string): string[] {
    const allServers = MCPServerRegistry.listServers();

    // TODO: Add agent-specific server filtering based on permissions/policies
    // For now, return all available servers
    logger.debug(`Available MCP servers for agent`, {
      operation: "mcp_available_servers",
      agentId,
      serverCount: allServers.length,
      serverIds: allServers,
      workspaceId: this.workspaceId,
    });

    return allServers;
  }

  /**
   * Initialize MCP servers for a session
   */
  async initializeServersForSession(
    serverIds: string[],
    sessionContext: SessionContext,
  ): Promise<void> {
    const configs = MCPServerRegistry.getServerConfigs(serverIds);

    if (configs.length === 0) {
      logger.warn(`No MCP server configs found for session initialization`, {
        operation: "mcp_session_initialization",
        sessionContext,
        requestedServerIds: serverIds,
        workspaceId: this.workspaceId,
      });
      return;
    }

    logger.info(`Initializing ${configs.length} MCP servers for session`, {
      operation: "mcp_session_initialization",
      sessionContext,
      serverCount: configs.length,
      serverIds: configs.map((c) => c.id),
      workspaceId: this.workspaceId,
    });

    try {
      // Use LLMProviderManager to initialize the servers
      await LLMProviderManager.initializeMCPServers(configs);

      logger.info(`MCP servers initialized successfully for session`, {
        operation: "mcp_session_initialization",
        sessionContext,
        serverCount: configs.length,
        success: true,
        workspaceId: this.workspaceId,
      });
    } catch (error) {
      logger.error(`Failed to initialize MCP servers for session`, {
        operation: "mcp_session_initialization",
        sessionContext,
        serverCount: configs.length,
        error: error instanceof Error ? error.message : String(error),
        workspaceId: this.workspaceId,
      });
      throw error;
    }
  }

  /**
   * Apply agent-specific configuration overrides
   */
  private applyAgentOverrides(
    baseConfig: MCPServerConfig,
    overrides?: MCPServerOverrides,
  ): MCPServerConfig {
    if (!overrides) return baseConfig;

    const overriddenConfig: MCPServerConfig = {
      ...baseConfig,
      tools: overrides.tools
        ? {
          allowed: overrides.tools.allowed || baseConfig.tools?.allowed,
          denied: [
            ...(baseConfig.tools?.denied || []),
            ...(overrides.tools.denied || []),
          ],
        }
        : baseConfig.tools,
      timeout_ms: overrides.timeout_ms || baseConfig.timeout_ms,
    };

    logger.debug(`Applied agent-specific overrides`, {
      operation: "mcp_agent_overrides",
      serverId: baseConfig.id,
      hasToolOverrides: !!overrides.tools,
      hasTimeoutOverride: !!overrides.timeout_ms,
      finalTimeout: overriddenConfig.timeout_ms,
    });

    return overriddenConfig;
  }

  /**
   * Apply security filtering based on agent permissions
   * TODO: Implement actual security policy checking
   */
  private applySecurityFiltering(
    config: MCPServerConfig,
    agentId: string,
  ): MCPServerConfig {
    // For now, return the config as-is
    // In the future, this would check agent permissions against server capabilities
    logger.debug(`Applied security filtering for agent`, {
      operation: "mcp_security_filtering",
      agentId,
      serverId: config.id,
      scope: config.scope,
    });

    return config;
  }
}
