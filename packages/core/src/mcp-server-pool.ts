/**
 * Global MCP Server Connection Pool
 *
 * Provides efficient connection pooling for MCP servers to avoid
 * spawning new processes for each agent execution.
 * Manages lifecycle with reference counting and automatic cleanup.
 */

import { createHash } from "node:crypto";
import type { MCPServerConfig } from "@atlas/config";
import type { Logger } from "@atlas/logger";
import { MCPManager } from "@atlas/mcp";
import { createErrorCause } from "./errors.ts";

interface PooledMCPManager {
  manager: MCPManager;
  serverConfigs: Map<string, MCPServerConfig>;
  refCount: number;
  lastUsed: number;
  cleanupTimer?: number;
}

export class GlobalMCPServerPool {
  private pooledManagers = new Map<string, PooledMCPManager>();
  private logger: Logger;
  private cleanupInterval = 5 * 60 * 1000; // 5 minutes
  private cleanupTimer?: number;

  constructor(logger: Logger) {
    this.logger = logger;
    this.startCleanupTimer();
  }

  /**
   * Gets an MCPManager for the given server configurations.
   * Creates a new pooled manager if one doesn't exist, otherwise reuses existing.
   *
   * @param serverConfigs Array of MCP server configurations
   * @returns Promise<MCPManager> Pooled MCP manager instance
   */
  async getMCPManager(serverConfigsMap: Record<string, MCPServerConfig>): Promise<MCPManager> {
    const serverConfigs = Object.entries(serverConfigsMap);
    if (serverConfigs.length === 0) {
      // Return empty manager for no servers
      return new MCPManager();
    }

    // Generate key based on server configurations
    const configKey = this.generateConfigKey(serverConfigsMap);

    let pooled = this.pooledManagers.get(configKey);
    if (!pooled) {
      // Create new MCPManager with all server configs
      const manager = new MCPManager();

      // Register all servers
      const serverConfigMap = new Map<string, MCPServerConfig>();
      for (const [id, config] of Object.entries(serverConfigsMap)) {
        try {
          // Add the id to the config for the MCP manager
          await manager.registerServer({ ...config, id });
          serverConfigMap.set(id, config);
        } catch (error) {
          const errorCause = createErrorCause(error);
          this.logger.error(`Failed to register MCP server in pool: ${id}`, {
            operation: "mcp_server_pool_registration",
            serverId: id,
            error: error,
            errorCause,
          });
          // Continue with other servers - don't fail the entire pool
        }
      }

      pooled = { manager, serverConfigs: serverConfigMap, refCount: 0, lastUsed: Date.now() };

      this.pooledManagers.set(configKey, pooled);
      this.logger.info(`Created new MCP server pool entry`, {
        operation: "mcp_server_pool_creation",
        configKey,
        serverCount: serverConfigs.length,
        registeredCount: serverConfigMap.size,
        serverIds: Array.from(serverConfigMap.keys()),
      });
    }

    // Increment reference count and update last used
    pooled.refCount++;
    pooled.lastUsed = Date.now();

    // Clear any existing cleanup timer
    if (pooled.cleanupTimer) {
      clearTimeout(pooled.cleanupTimer);
      pooled.cleanupTimer = undefined;
    }

    this.logger.debug(`Retrieved MCP manager from pool`, {
      operation: "mcp_server_pool_get",
      configKey,
      refCount: pooled.refCount,
      serverCount: pooled.serverConfigs.size,
    });

    return pooled.manager;
  }

  /**
   * Releases a reference to an MCPManager.
   * Starts cleanup timer if no more references exist.
   *
   * @param serverConfigs Array of MCP server configurations that were used
   */
  releaseMCPManager(serverConfigsMap: Record<string, MCPServerConfig>): void {
    if (Object.keys(serverConfigsMap).length === 0) {
      return; // Nothing to release for empty manager
    }

    const configKey = this.generateConfigKey(serverConfigsMap);
    const pooled = this.pooledManagers.get(configKey);

    if (pooled) {
      pooled.refCount = Math.max(0, pooled.refCount - 1);
      pooled.lastUsed = Date.now();

      this.logger.debug(`Released MCP manager reference`, {
        operation: "mcp_server_pool_release",
        configKey,
        refCount: pooled.refCount,
      });

      // Set cleanup timer if no active references
      if (pooled.refCount <= 0) {
        pooled.cleanupTimer = setTimeout(() => {
          this.cleanupPooledManager(configKey);
        }, this.cleanupInterval);

        this.logger.debug(`Started cleanup timer for MCP pool entry`, {
          operation: "mcp_server_pool_cleanup_timer",
          configKey,
          cleanupDelayMs: this.cleanupInterval,
        });
      }
    }
  }

  /**
   * Gets statistics about the current pool state
   */
  getPoolStats(): {
    totalPooledManagers: number;
    activeReferences: number;
    serverConfigurations: Array<{
      configKey: string;
      refCount: number;
      serverCount: number;
      lastUsedAgo: number;
    }>;
  } {
    const now = Date.now();
    let totalRefs = 0;

    const configurations = Array.from(this.pooledManagers.entries()).map(([key, pooled]) => {
      totalRefs += pooled.refCount;
      return {
        configKey: key,
        refCount: pooled.refCount,
        serverCount: pooled.serverConfigs.size,
        lastUsedAgo: now - pooled.lastUsed,
      };
    });

    return {
      totalPooledManagers: this.pooledManagers.size,
      activeReferences: totalRefs,
      serverConfigurations: configurations,
    };
  }

  /**
   * Forcefully dispose all pooled managers (for shutdown)
   */
  async dispose(): Promise<void> {
    this.logger.info("Disposing MCP server pool", {
      operation: "mcp_server_pool_dispose",
      pooledManagerCount: this.pooledManagers.size,
    });

    // Clear main cleanup timer
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }

    // Dispose all pooled managers
    const disposePromises = Array.from(this.pooledManagers.entries()).map(async ([key, pooled]) => {
      if (pooled.cleanupTimer) {
        clearTimeout(pooled.cleanupTimer);
      }
      try {
        await pooled.manager.dispose();
      } catch (error) {
        const errorCause = createErrorCause(error);
        this.logger.error(`Error disposing pooled MCP manager: ${key}`, {
          operation: "mcp_server_pool_dispose",
          configKey: key,
          error: error,
          errorCause,
        });
      }
    });

    await Promise.allSettled(disposePromises);
    this.pooledManagers.clear();

    this.logger.info("MCP server pool disposed", {
      operation: "mcp_server_pool_dispose",
      success: true,
    });
  }

  generateConfigKey(serverConfigsMap: Record<string, MCPServerConfig>): string {
    // Hash sorted server IDs + full config to distinguish pools with
    // the same servers but different transport/auth/env settings.
    const sorted = Object.keys(serverConfigsMap)
      .sort()
      .map((id) => [id, serverConfigsMap[id]]);
    return createHash("sha256").update(JSON.stringify(sorted)).digest("hex");
  }

  private async cleanupPooledManager(configKey: string): Promise<void> {
    const pooled = this.pooledManagers.get(configKey);
    if (pooled && pooled.refCount <= 0) {
      this.logger.info(`Cleaning up unused MCP server pool entry`, {
        operation: "mcp_server_pool_cleanup",
        configKey,
        serverCount: pooled.serverConfigs.size,
        lastUsedAgo: Date.now() - pooled.lastUsed,
      });

      try {
        await pooled.manager.dispose();
        this.pooledManagers.delete(configKey);

        this.logger.info(`Successfully cleaned up MCP server pool entry`, {
          operation: "mcp_server_pool_cleanup",
          configKey,
          success: true,
        });
      } catch (error) {
        const errorCause = createErrorCause(error);
        this.logger.error(`Error cleaning up MCP server pool entry: ${configKey}`, {
          operation: "mcp_server_pool_cleanup",
          configKey,
          error: error,
          errorCause,
        });
      }
    }
  }

  private startCleanupTimer(): void {
    this.cleanupTimer = setInterval(() => {
      const now = Date.now();
      const cleanupPromises: Promise<void>[] = [];

      for (const [key, pooled] of this.pooledManagers.entries()) {
        if (pooled.refCount <= 0 && now - pooled.lastUsed > this.cleanupInterval) {
          cleanupPromises.push(this.cleanupPooledManager(key));
        }
      }

      if (cleanupPromises.length > 0) {
        Promise.allSettled(cleanupPromises).then(() => {
          this.logger.debug(`Completed periodic MCP pool cleanup`, {
            operation: "mcp_server_pool_periodic_cleanup",
            cleanedUp: cleanupPromises.length,
            remaining: this.pooledManagers.size,
          });
        });
      }
    }, this.cleanupInterval);
  }
}
