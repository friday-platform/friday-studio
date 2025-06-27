/**
 * MCP Server Registry - Workspace-level registry for MCP server configurations
 * Provides hierarchical configuration resolution (platform -> workspace -> agent)
 * Mirrors the pattern established in LLMProviderManager
 */

import { logger } from "../../../utils/logger.ts";
import { type MCPServerConfig } from "./mcp-manager.ts";

// Type definitions for configuration sources
export interface AtlasConfig {
  tools?: {
    mcp?: {
      servers?: Record<string, Partial<MCPServerConfig>>;
    };
  };
  [key: string]: unknown;
}

export interface WorkspaceConfig {
  tools?: {
    mcp?: {
      servers?: Record<string, Partial<MCPServerConfig>>;
    };
  };
  [key: string]: unknown;
}

export interface AgentConfig {
  mcp_server_overrides?: Record<string, MCPServerOverrides>;
  [key: string]: unknown;
}

export interface MCPServerOverrides {
  tools?: {
    allowed?: string[];
    denied?: string[];
  };
  timeout_ms?: number;
}

export interface SessionContext {
  sessionId: string;
  agentId: string;
  workspaceId?: string;
}

/**
 * Workspace-level MCP Server Registry
 * Manages hierarchical MCP server configuration resolution
 */
export class MCPServerRegistry {
  private static serverConfigs: Map<string, MCPServerConfig> = new Map();
  private static initialized = false;

  /**
   * Initialize registry with hierarchical configuration resolution
   * @param atlasConfig Platform-level MCP server declarations
   * @param workspaceConfig Workspace-level MCP server declarations
   */
  static initialize(
    atlasConfig?: AtlasConfig,
    workspaceConfig?: WorkspaceConfig,
  ): void {
    if (this.initialized) return;

    // 1. Load platform-level MCP servers from atlas.yml
    const platformServers = this.extractPlatformMCPServers(atlasConfig);

    // 2. Load workspace-level MCP servers from workspace.yml
    const workspaceServers = this.extractWorkspaceMCPServers(workspaceConfig);

    // 3. Merge with workspace overriding platform (hierarchical resolution)
    const mergedServers = this.mergeServerConfigurations(
      platformServers,
      workspaceServers,
    );

    // 4. Register all servers in the registry
    for (const [serverId, config] of mergedServers) {
      this.serverConfigs.set(serverId, config);
    }

    logger.info(
      `MCP Server Registry initialized with ${this.serverConfigs.size} servers`,
      {
        operation: "mcp_registry_initialization",
        platformServerCount: platformServers.size,
        workspaceServerCount: workspaceServers.size,
        totalServerCount: this.serverConfigs.size,
        serverIds: Array.from(this.serverConfigs.keys()),
      },
    );

    this.initialized = true;
  }

  /**
   * Extract platform-level MCP servers from atlas.yml
   * Uses new format: tools.mcp.servers
   */
  private static extractPlatformMCPServers(
    atlasConfig?: AtlasConfig,
  ): Map<string, MCPServerConfig> {
    const servers = new Map<string, MCPServerConfig>();

    if (!atlasConfig) return servers;

    // Extract from new format: tools.mcp.servers
    const mcpServers = atlasConfig.tools?.mcp?.servers;
    if (mcpServers) {
      for (const [serverId, config] of Object.entries(mcpServers)) {
        servers.set(serverId, {
          ...config,
          id: serverId,
          timeout_ms: config.timeout_ms || 30000,
          scope: "platform",
        } as MCPServerConfig);
      }
    }

    logger.debug(`Extracted ${servers.size} platform MCP servers`, {
      operation: "mcp_platform_extraction",
      serverCount: servers.size,
      serverIds: Array.from(servers.keys()),
    });

    return servers;
  }

  /**
   * Extract workspace-level MCP servers from workspace.yml
   * Uses new format: tools.mcp.servers
   */
  private static extractWorkspaceMCPServers(
    workspaceConfig?: WorkspaceConfig,
  ): Map<string, MCPServerConfig> {
    const servers = new Map<string, MCPServerConfig>();

    if (!workspaceConfig) return servers;

    // Extract from new format: tools.mcp.servers
    const mcpServers = workspaceConfig.tools?.mcp?.servers;
    if (mcpServers) {
      for (const [serverId, config] of Object.entries(mcpServers)) {
        servers.set(serverId, {
          ...config,
          id: serverId,
          timeout_ms: config.timeout_ms || 30000,
          scope: "workspace",
        } as MCPServerConfig);
      }
    }

    logger.debug(`Extracted ${servers.size} workspace MCP servers`, {
      operation: "mcp_workspace_extraction",
      serverCount: servers.size,
      serverIds: Array.from(servers.keys()),
    });

    return servers;
  }

  /**
   * Merge platform and workspace server configurations with proper precedence
   * Workspace configurations override platform configurations for same server IDs
   */
  private static mergeServerConfigurations(
    platformServers: Map<string, MCPServerConfig>,
    workspaceServers: Map<string, MCPServerConfig>,
  ): Map<string, MCPServerConfig> {
    const merged = new Map<string, MCPServerConfig>();

    // 1. Add all platform servers first
    for (const [serverId, config] of platformServers) {
      merged.set(serverId, {
        ...config,
        scope: "platform",
      });
    }

    // 2. Override with workspace servers (workspace takes precedence)
    for (const [serverId, config] of workspaceServers) {
      const platformConfig = merged.get(serverId);

      if (platformConfig) {
        // Merge platform and workspace configs intelligently
        merged.set(serverId, this.mergeServerConfig(platformConfig, config));

        logger.debug(
          `Merged platform and workspace config for server: ${serverId}`,
          {
            operation: "mcp_config_merge",
            serverId,
            hasPlatformConfig: true,
            hasWorkspaceConfig: true,
          },
        );
      } else {
        // Workspace-only server
        merged.set(serverId, {
          ...config,
          scope: "workspace",
        });
      }
    }

    logger.debug(`Configuration merge completed`, {
      operation: "mcp_config_merge",
      platformCount: platformServers.size,
      workspaceCount: workspaceServers.size,
      mergedCount: merged.size,
    });

    return merged;
  }

  /**
   * Intelligently merge platform and workspace server configurations
   */
  private static mergeServerConfig(
    platformConfig: MCPServerConfig,
    workspaceConfig: MCPServerConfig,
  ): MCPServerConfig {
    return {
      id: workspaceConfig.id,
      // Workspace transport overrides platform transport
      transport: workspaceConfig.transport,
      // Workspace auth overrides platform auth
      auth: workspaceConfig.auth || platformConfig.auth,
      // Merge tools: workspace denied list appends to platform denied list
      tools: {
        allowed: workspaceConfig.tools?.allowed ||
          platformConfig.tools?.allowed,
        denied: [
          ...(platformConfig.tools?.denied || []),
          ...(workspaceConfig.tools?.denied || []),
        ],
      },
      // Workspace timeout overrides platform timeout
      timeout_ms: workspaceConfig.timeout_ms || platformConfig.timeout_ms,
      scope: "merged", // Indicates this config comes from both levels
    };
  }

  /**
   * Get server configuration with proper error handling
   */
  static getServerConfig(serverId: string): MCPServerConfig | undefined {
    if (!this.initialized) {
      logger.warn("MCP Server Registry not initialized", {
        operation: "mcp_registry_access",
        serverId,
        initialized: false,
      });
      return undefined;
    }

    return this.serverConfigs.get(serverId);
  }

  /**
   * Get server configurations for multiple servers with availability checking
   */
  static getServerConfigs(serverIds: string[]): MCPServerConfig[] {
    if (!this.initialized) {
      logger.warn("MCP Server Registry not initialized", {
        operation: "mcp_registry_access",
        serverIds,
        initialized: false,
      });
      return [];
    }

    return serverIds
      .map((id) => this.serverConfigs.get(id))
      .filter((config): config is MCPServerConfig => config !== undefined);
  }

  /**
   * Check if the registry has been initialized
   */
  static isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * List all registered server IDs
   */
  static listServers(): string[] {
    return Array.from(this.serverConfigs.keys());
  }

  /**
   * Get the status of all registered MCP servers
   */
  static getRegisteredServers(): Map<string, MCPServerConfig> {
    return new Map(this.serverConfigs);
  }

  /**
   * Clear the registry (for testing purposes)
   */
  static reset(): void {
    this.serverConfigs.clear();
    this.initialized = false;
    logger.debug("MCP Server Registry reset", {
      operation: "mcp_registry_reset",
    });
  }
}
