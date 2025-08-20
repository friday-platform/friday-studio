/**
 * MCP Server Registry - Workspace-level registry for MCP server configurations
 * Provides hierarchical configuration resolution (platform -> workspace -> agent)
 * Mirrors the pattern established in LLMProviderManager
 */

import { logger } from "@atlas/logger";
import { getAtlasDaemonUrl } from "@atlas/atlasd";
import { type MCPServerConfig } from "./manager.ts";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { experimental_createMCPClient as createMCPClient } from "ai";

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
    allow?: string[];
    deny?: string[];
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
  private static initializationPromise: Promise<void> | null = null;
  private static cachedPlatformTools: string[] | null = null;

  /**
   * Initialize registry with hierarchical configuration resolution
   * @param atlasConfig Platform-level MCP server declarations
   * @param workspaceConfig Workspace-level MCP server declarations
   */
  static async initialize(
    atlasConfig?: AtlasConfig,
    workspaceConfig?: WorkspaceConfig,
  ): Promise<void> {
    // If already initialized, return immediately
    if (this.initialized) return;

    // If initialization is in progress, wait for it to complete
    if (this.initializationPromise) {
      logger.debug("MCPServerRegistry initialization already in progress, waiting...", {
        operation: "mcp_registry_initialization",
      });
      return await this.initializationPromise;
    }

    // Start initialization and store the promise to prevent concurrent initialization
    this.initializationPromise = this.doInitialize(atlasConfig, workspaceConfig);

    try {
      await this.initializationPromise;
      this.initialized = true;
    } catch (error) {
      // Clear the promise so initialization can be retried
      this.initializationPromise = null;
      throw error;
    }
  }

  private static async doInitialize(
    atlasConfig?: AtlasConfig,
    workspaceConfig?: WorkspaceConfig,
  ): Promise<void> {
    // Debug logging to understand what's being passed
    logger.debug("MCPServerRegistry.doInitialize starting", {
      operation: "mcp_registry_initialization",
      hasAtlasConfig: !!atlasConfig,
      hasWorkspaceConfig: !!workspaceConfig,
      workspaceConfigKeys: workspaceConfig ? Object.keys(workspaceConfig) : [],
      hasTools: !!workspaceConfig?.tools,
      hasMcp: !!workspaceConfig?.tools?.mcp,
      hasServers: !!workspaceConfig?.tools?.mcp?.servers,
      serverIds: workspaceConfig?.tools?.mcp?.servers
        ? Object.keys(workspaceConfig.tools.mcp.servers)
        : [],
    });

    // Get platform tools with retry logic
    const platformTools = await this.getAllPlatformToolsWithRetry();

    const atlasConfigWithPlatform = this.injectPlatformServer(atlasConfig, platformTools);

    // 1. Load platform-level MCP servers from atlas.yml (now includes atlas-platform)
    const platformServers = this.extractPlatformMCPServers(atlasConfigWithPlatform);

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
        platformToolCount: platformTools.length,
      },
    );
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
        allow: workspaceConfig.tools?.allow ||
          platformConfig.tools?.allow,
        deny: [
          ...(platformConfig.tools?.deny || []),
          ...(workspaceConfig.tools?.deny || []),
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
    this.initializationPromise = null;
    this.cachedPlatformTools = null;
    logger.debug("MCP Server Registry reset", {
      operation: "mcp_registry_reset",
    });
  }

  /**
   * Get platform tools with retry logic
   */
  private static async getAllPlatformToolsWithRetry(maxRetries = 3): Promise<string[]> {
    // Return cached tools if available
    if (this.cachedPlatformTools && this.cachedPlatformTools.length > 0) {
      logger.debug("Using cached platform tools", {
        operation: "mcp_registry_initialization",
        toolCount: this.cachedPlatformTools.length,
      });
      return this.cachedPlatformTools;
    }

    // If we're already fetching tools, wait for that to complete
    // This prevents multiple concurrent fetches
    if (this.platformToolsFetchPromise) {
      logger.debug("Platform tools fetch already in progress, waiting...", {
        operation: "mcp_registry_initialization",
      });
      try {
        return await this.platformToolsFetchPromise;
      } catch {
        // If the concurrent fetch failed, we'll try again below
      }
    }

    // Start fetching tools
    this.platformToolsFetchPromise = this.fetchPlatformToolsWithRetry(maxRetries);

    try {
      const tools = await this.platformToolsFetchPromise;
      return tools;
    } finally {
      // Clear the promise so future calls can retry if needed
      this.platformToolsFetchPromise = null;
    }
  }

  private static platformToolsFetchPromise: Promise<string[]> | null = null;

  private static async fetchPlatformToolsWithRetry(maxRetries: number): Promise<string[]> {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        // Use a reasonable timeout that gives the server time to respond
        const timeout = 3000; // 3 seconds - consistent timeout
        const tools = await this.getAllPlatformTools(timeout);

        // Cache the tools for future use
        this.cachedPlatformTools = tools;
        logger.info("Successfully fetched platform tools", {
          operation: "mcp_registry_initialization",
          attempt,
          toolCount: tools.length,
        });
        return tools;
      } catch (error) {
        lastError = error as Error;

        // Only log at debug level for timeout errors
        const isTimeout = error instanceof Error && error.message.includes("timeout");
        if (isTimeout) {
          logger.debug(`Platform tools fetch attempt ${attempt}/${maxRetries} timed out`, {
            operation: "mcp_registry_initialization",
            attempt,
          });
        } else {
          logger.warn(`Failed to get platform tools (attempt ${attempt}/${maxRetries})`, {
            operation: "mcp_registry_initialization",
            attempt,
            error: error instanceof Error ? error.message : String(error),
          });
        }

        // Wait before retrying with exponential backoff
        if (attempt < maxRetries) {
          const delay = Math.min(1000 * Math.pow(2, attempt - 1), 5000); // 1s, 2s, 4s (max 5s)
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    // If all retries failed, return empty array
    // The platform server will be registered without specific tool filtering
    logger.info("Platform MCP server tools unavailable, registering without tool list", {
      operation: "mcp_registry_initialization",
      error: lastError?.message,
      retries: maxRetries,
    });

    // Return empty array but still register the server
    // The server can still work, just without pre-filtered tools
    this.cachedPlatformTools = [];
    return [];
  }

  /**
   * Get all available platform tools from the MCP server
   */
  private static async getAllPlatformTools(timeoutMs = 3000): Promise<string[]> {
    try {
      const daemonUrl = getAtlasDaemonUrl();
      logger.debug("Fetching platform tools from MCP server", {
        daemonUrl,
        endpoint: `${daemonUrl}/mcp`,
        timeoutMs,
      });

      // Create MCP client with HTTP transport WITH TIMEOUT
      const transport = new StreamableHTTPClientTransport(
        new URL(`${daemonUrl}/mcp`),
        {
          requestInit: {
            // Add timeout to prevent hanging when daemon is busy
            signal: AbortSignal.timeout(timeoutMs),
          },
        },
      );

      // Wrap client creation with timeout
      const mcpClient = await Promise.race([
        createMCPClient({ transport }),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error("Platform tools MCP client creation timeout")),
            timeoutMs,
          )
        ),
      ]);

      // Get tools from the MCP client with timeout
      const tools = await Promise.race([
        mcpClient.tools(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Platform tools fetch timeout")), timeoutMs)
        ),
      ]);
      const toolNames = Object.keys(tools);

      if (toolNames.length === 0) {
        throw new Error("No tools returned from MCP server");
      }

      logger.info(`Successfully fetched ${toolNames.length} platform tools from MCP server`);

      // Close the client after use
      await mcpClient.close();

      return toolNames;
    } catch (error) {
      logger.error("Failed to get platform tools dynamically", {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });

      // Don't throw - getAllPlatformToolsWithRetry will handle this
      // The retry logic already handles this gracefully
      logger.debug("Platform tools fetch failed, returning empty array", {
        operation: "mcp_platform_tools",
        error: error instanceof Error ? error.message : String(error),
      });

      // Return empty array - getAllPlatformToolsWithRetry will handle retry logic
      return [];
    }
  }

  /**
   * Inject atlas-platform MCP server configuration into atlas config
   */
  private static injectPlatformServer(
    atlasConfig: AtlasConfig | undefined,
    platformTools: string[],
  ): AtlasConfig {
    // Create the platform MCP server configuration
    // Even if we don't have the tools list yet, we still register the server
    const platformMCPServer: Partial<MCPServerConfig> = {
      transport: {
        type: "http" as const,
        url: `${getAtlasDaemonUrl()}/mcp`,
      },
    };

    // Only add tool filtering if we have the list
    if (platformTools.length > 0) {
      platformMCPServer.tools = {
        allow: platformTools,
      };
      logger.debug("Platform server configured with tool filtering", {
        operation: "mcp_registry_initialization",
        toolCount: platformTools.length,
      });
    } else {
      logger.debug("Platform server configured without tool filtering (all tools available)", {
        operation: "mcp_registry_initialization",
      });
    }

    // Merge platform server into atlas config
    if (!atlasConfig) {
      return {
        tools: {
          mcp: {
            servers: {
              "atlas-platform": platformMCPServer,
            },
          },
        },
      };
    }

    return {
      ...atlasConfig,
      tools: {
        ...atlasConfig.tools,
        mcp: {
          ...atlasConfig.tools?.mcp,
          servers: {
            ...atlasConfig.tools?.mcp?.servers,
            "atlas-platform": platformMCPServer,
          },
        },
      },
    };
  }
}
