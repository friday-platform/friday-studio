/**
 * MCP Configuration Service - Provides clean interface for MCP server configuration resolution
 * Eliminates direct workspace config access from agent execution workers
 */

import { logger } from "../../../src/utils/logger.ts";
import {
  type AgentConfig,
  type MCPServerOverrides,
  MCPServerRegistry,
  type SessionContext,
} from "./registry.ts";
import { type MCPServerConfig } from "./manager.ts";

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
    private mcpServerConfigs?: Record<string, any>, // Direct MCP server configurations for worker contexts
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
      // Get base configuration from direct configs or registry (dual-mode resolution)
      let baseConfig: MCPServerConfig | undefined;

      if (this.mcpServerConfigs && this.mcpServerConfigs[serverId]) {
        // Use direct configuration if available (for worker contexts)
        baseConfig = {
          ...this.mcpServerConfigs[serverId],
          id: serverId, // Ensure the config has the correct id field
        } as MCPServerConfig;
        logger.debug(`Using direct MCP server config for: ${serverId}`, {
          operation: "mcp_config_resolution",
          agentId,
          serverId,
          source: "direct",
          workspaceId: this.workspaceId,
        });
      } else {
        // Fallback to registry for non-worker contexts
        baseConfig = MCPServerRegistry.getServerConfig(serverId);
        if (baseConfig) {
          logger.debug(`Using registry MCP server config for: ${serverId}`, {
            operation: "mcp_config_resolution",
            agentId,
            serverId,
            source: "registry",
            workspaceId: this.workspaceId,
          });
        }
      }

      if (!baseConfig) {
        if (!MCPServerRegistry.isInitialized()) {
          logger.warn(`MCP Server Registry not initialized`, {
            operation: "mcp_config_resolution",
            agentId,
            serverId,
            available: false,
            workspaceId: this.workspaceId,
          });
        } else {
          logger.warn(`MCP server not found in registry: ${serverId}`, {
            operation: "mcp_config_resolution",
            agentId,
            serverId,
            available: false,
            workspaceId: this.workspaceId,
          });
        }
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
        finalToolCount: secureConfig.tools?.allow?.length || 0,
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
    // Use direct configurations if available (for worker contexts), otherwise fall back to registry
    let configs: MCPServerConfig[] = [];

    if (this.mcpServerConfigs) {
      // Use direct configurations from workspace
      for (const serverId of serverIds) {
        if (this.mcpServerConfigs[serverId]) {
          configs.push({
            ...this.mcpServerConfigs[serverId],
            id: serverId, // Ensure the config has the correct id field
          } as MCPServerConfig);
        }
      }
      logger.debug(`Using direct MCP server configs for session initialization`, {
        operation: "mcp_session_initialization",
        sessionContext,
        requestedServerIds: serverIds,
        resolvedCount: configs.length,
        source: "direct",
        workspaceId: this.workspaceId,
      });
    } else {
      // Fallback to registry for non-worker contexts
      configs = MCPServerRegistry.getServerConfigs(serverIds);
      logger.debug(`Using registry MCP server configs for session initialization`, {
        operation: "mcp_session_initialization",
        sessionContext,
        requestedServerIds: serverIds,
        resolvedCount: configs.length,
        source: "registry",
        workspaceId: this.workspaceId,
      });
    }

    if (configs.length === 0) {
      logger.warn(`No MCP server configs found for session initialization`, {
        operation: "mcp_session_initialization",
        sessionContext,
        requestedServerIds: serverIds,
        hasDirectConfigs: !!this.mcpServerConfigs,
        registryInitialized: MCPServerRegistry.isInitialized(),
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
      // MCP servers are initialized on-demand when tools are requested
      // No need to pre-initialize them here

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
          allow: overrides.tools.allow || baseConfig.tools?.allow,
          deny: [
            ...(baseConfig.tools?.deny || []),
            ...(overrides.tools.deny || []),
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
