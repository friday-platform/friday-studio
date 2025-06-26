/**
 * Enhanced MCP Manager with Environment Resolution
 * Extends Sara's MCP manager with comprehensive credential management
 */

import { MCPManager as BaseMCPManager, type MCPServerConfig } from "../agents/mcp/mcp-manager.ts";
import { EnvironmentResolver } from "../environment-resolver.ts";
import type { EnvironmentVariable } from "@atlas/types";
import { logger } from "../../utils/logger.ts";

export interface EnhancedMCPServerConfig extends Omit<MCPServerConfig, "transport"> {
  transport: {
    type: "stdio" | "sse";
    command?: string;
    args?: string[];
    url?: string;
    env?: Record<string, EnvironmentVariable>; // Enhanced environment config
  };
  auth?: {
    type: "bearer" | "api_key";
    token?: EnvironmentVariable; // Enhanced token config
    header?: string;
  };
}

export class EnhancedMCPManager extends BaseMCPManager {
  private environmentResolver: EnvironmentResolver;

  constructor() {
    super();
    this.environmentResolver = new EnvironmentResolver();
  }

  /**
   * Register server with enhanced environment variable resolution
   */
  async registerEnhancedServer(config: EnhancedMCPServerConfig): Promise<void> {
    // Resolve environment variables
    const resolvedConfig = await this.resolveServerEnvironment(config);

    // Convert to base config and register
    await this.registerServer(resolvedConfig);
  }

  /**
   * Resolve all environment variables in server configuration
   */
  private async resolveServerEnvironment(
    config: EnhancedMCPServerConfig,
  ): Promise<MCPServerConfig> {
    const resolved: MCPServerConfig = {
      id: config.id,
      transport: {
        type: config.transport.type,
      } as any,
      auth: config.auth
        ? {
          type: config.auth.type,
          header: config.auth.header,
        }
        : undefined,
      tools: config.tools,
      timeout_ms: config.timeout_ms,
      scope: config.scope,
    };

    // Resolve transport configuration
    if (config.transport.type === "stdio") {
      resolved.transport = {
        type: "stdio",
        command: config.transport.command!,
        args: config.transport.args,
        env: await this.resolveEnvironmentRecord(config.transport.env),
      };
    } else if (config.transport.type === "sse") {
      resolved.transport = {
        type: "sse",
        url: config.transport.url!,
      };
    }

    // Resolve auth configuration
    if (config.auth?.token) {
      const tokenResult = await this.environmentResolver.resolve("token", config.auth.token);
      if (tokenResult.resolved) {
        resolved.auth!.token_env = "RESOLVED_TOKEN"; // Use a placeholder
        // Set the resolved token in environment for the base manager to find
        Deno.env.set("RESOLVED_TOKEN", tokenResult.value);

        logger.debug("Resolved MCP server auth token", {
          operation: "enhanced_mcp_env_resolution",
          serverId: config.id,
          source: tokenResult.source,
        });
      }
    }

    return resolved;
  }

  /**
   * Resolve environment variable record
   */
  private async resolveEnvironmentRecord(
    envConfig?: Record<string, EnvironmentVariable>,
  ): Promise<Record<string, string> | undefined> {
    if (!envConfig) return undefined;

    try {
      return await this.environmentResolver.resolveAll(envConfig);
    } catch (error) {
      logger.error("Failed to resolve MCP server environment variables", {
        operation: "enhanced_mcp_env_resolution",
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Bulk register servers with environment resolution
   */
  async registerEnhancedServers(configs: EnhancedMCPServerConfig[]): Promise<void> {
    const results = await Promise.allSettled(
      configs.map((config) => this.registerEnhancedServer(config)),
    );

    const errors = results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result, index) => ({
        serverId: configs[index].id,
        error: result.reason,
      }));

    if (errors.length > 0) {
      logger.error("Some MCP servers failed to register", {
        operation: "enhanced_mcp_bulk_registration",
        failedServers: errors.length,
        totalServers: configs.length,
        errors: errors.map((e) => `${e.serverId}: ${e.error.message || e.error}`),
      });

      throw new Error(
        `Failed to register ${errors.length} MCP servers:\n${
          errors.map((e) => `  ${e.serverId}: ${e.error.message || e.error}`).join("\n")
        }`,
      );
    }

    logger.info("Successfully registered all enhanced MCP servers", {
      operation: "enhanced_mcp_bulk_registration",
      serversCount: configs.length,
    });
  }

  /**
   * Convert legacy MCP server configs to enhanced format
   */
  static convertLegacyConfig(legacyConfig: MCPServerConfig): EnhancedMCPServerConfig {
    const enhanced: EnhancedMCPServerConfig = {
      id: legacyConfig.id,
      transport: {
        type: legacyConfig.transport.type,
      },
      auth: legacyConfig.auth,
      tools: legacyConfig.tools,
      timeout_ms: legacyConfig.timeout_ms,
      scope: legacyConfig.scope,
    };

    if (legacyConfig.transport.type === "stdio") {
      enhanced.transport = {
        type: "stdio",
        command: legacyConfig.transport.command,
        args: legacyConfig.transport.args,
        // Convert simple env record to EnvironmentVariable format
        env: legacyConfig.transport.env
          ? Object.fromEntries(
            Object.entries(legacyConfig.transport.env).map(([key, value]) => [
              key,
              { from_env: key, default: value } as EnvironmentVariable,
            ]),
          )
          : undefined,
      };
    } else {
      enhanced.transport = {
        type: "sse",
        url: legacyConfig.transport.url,
      };
    }

    // Convert auth token_env to EnvironmentVariable format
    if (legacyConfig.auth?.token_env) {
      enhanced.auth = {
        ...legacyConfig.auth,
        token: { from_env: legacyConfig.auth.token_env } as EnvironmentVariable,
      };
      delete (enhanced.auth as any).token_env;
    }

    return enhanced;
  }

  /**
   * Create enhanced MCP server configuration for common scenarios
   */
  static createCommonConfigs(): {
    github: EnhancedMCPServerConfig;
    filesystem: EnhancedMCPServerConfig;
    linear: EnhancedMCPServerConfig;
  } {
    return {
      github: {
        id: "github-mcp",
        transport: {
          type: "stdio",
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-github"],
          env: {
            GITHUB_PERSONAL_ACCESS_TOKEN: {
              from_env: "GITHUB_TOKEN",
              from_env_file: ".env",
              key: "GITHUB_TOKEN",
              required: true,
            },
          },
        },
        tools: {
          allowed: ["create_or_update_file", "get_file_contents", "push_files"],
        },
      },

      filesystem: {
        id: "filesystem-mcp",
        transport: {
          type: "stdio",
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-filesystem", "/workspace"],
        },
        tools: {
          allowed: ["read_file", "write_file", "list_directory"],
        },
      },

      linear: {
        id: "linear-mcp",
        transport: {
          type: "stdio",
          command: "npx",
          args: ["-y", "linear-mcp-server"],
          env: {
            LINEAR_API_KEY: {
              from_env: "LINEAR_API_KEY",
              from_file: "/run/secrets/linear_api_key",
              required: true,
            },
          },
        },
        tools: {
          allowed: ["linear_create_issue", "linear_update_issue", "linear_get_issue"],
        },
      },
    };
  }
}
