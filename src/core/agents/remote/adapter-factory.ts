/**
 * Factory for creating protocol-specific remote adapters
 * Supports ACP and MCP protocols
 */

import type { RemoteAgentConfig } from "./remote-agent.ts";
import { BaseRemoteAdapter, type BaseRemoteAdapterConfig } from "./adapters/base-remote-adapter.ts";
import { logger } from "../../../utils/logger.ts";

export type RemoteProtocol = "acp" | "mcp";

/**
 * Factory class for creating remote agent adapters
 */
export class RemoteAdapterFactory {
  private static logger = logger.createChildLogger({ component: "AdapterFactory" });

  /**
   * Create adapter for the specified protocol
   */
  static createAdapter(
    protocol: RemoteProtocol,
    config: RemoteAgentConfig,
  ): Promise<BaseRemoteAdapter> {
    this.logger.info("Creating remote adapter", { protocol, endpoint: config.endpoint });

    const baseConfig = this.buildBaseConfig(config);

    switch (protocol) {
      case "acp":
        return this.createACPAdapter(baseConfig, config);
      case "mcp":
        return this.createMCPAdapter(baseConfig, config);
      default:
        throw new Error(`Unsupported remote protocol: ${protocol}`);
    }
  }

  /**
   * Create ACP (Agent Communication Protocol) adapter
   */
  private static async createACPAdapter(
    baseConfig: BaseRemoteAdapterConfig,
    config: RemoteAgentConfig,
  ): Promise<BaseRemoteAdapter> {
    try {
      // Dynamic import to avoid loading ACP dependencies unless needed
      const { ACPAdapter } = await import("./adapters/acp-adapter.ts");

      // Validate required ACP configuration
      if (!config.acp?.agent_name) {
        throw new Error("ACP configuration requires 'agent_name' field");
      }

      const acpConfig = {
        ...baseConfig,
        endpoint: config.endpoint,
        acp: {
          agent_name: config.acp.agent_name,
          default_mode: (config.acp?.default_mode || "sync") as "sync" | "async" | "stream",
          timeout_ms: config.acp?.timeout_ms || 30000,
          max_retries: config.acp?.max_retries || 3,
          health_check_interval: config.acp?.health_check_interval || 60000,
        },
      };

      return new ACPAdapter(acpConfig);
    } catch (error) {
      this.logger.error("Failed to create ACP adapter", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw new Error(
        `Failed to create ACP adapter: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Create MCP (Model Context Protocol) adapter
   */
  private static async createMCPAdapter(
    baseConfig: BaseRemoteAdapterConfig,
    config: RemoteAgentConfig,
  ): Promise<BaseRemoteAdapter> {
    try {
      const { MCPAdapter } = await import("../../../../packages/mcp/src/adapters/mcp-adapter.ts");

      const mcpConfig = {
        ...baseConfig,
        timeout_ms: config.mcp?.timeout_ms || 30000,
        allowed_tools: config.mcp?.allowed_tools,
        denied_tools: config.mcp?.denied_tools,
      };

      return new MCPAdapter(mcpConfig);
    } catch (error) {
      this.logger.error("Failed to create MCP adapter", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw new Error(
        `Failed to create MCP adapter: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Build base configuration from remote agent config
   */
  private static buildBaseConfig(config: RemoteAgentConfig): BaseRemoteAdapterConfig {
    return {
      connection: {
        endpoint: config.endpoint,
        timeout: config.timeout || 30000,
        retries: 3,
        keepAlive: true,
      },
      auth: config.auth,
      retry: {
        max_attempts: 3,
        base_delay_ms: 1000,
        max_delay_ms: 10000,
        backoff_multiplier: 2,
        retryable_errors: [
          "NetworkError",
          "TimeoutError",
          "ECONNRESET",
          "ENOTFOUND",
          "timeout",
          "connection",
        ],
      },
      circuit_breaker: {
        failure_threshold: config.monitoring?.circuit_breaker?.failure_threshold || 5,
        timeout_ms: config.monitoring?.circuit_breaker?.timeout_ms || 60000,
        half_open_max_calls: config.monitoring?.circuit_breaker?.half_open_max_calls || 3,
      },
      monitoring: {
        enabled: config.monitoring?.enabled !== false,
        health_check_interval_ms: config.acp?.health_check_interval || 60000,
      },
    };
  }

  /**
   * Validate remote agent configuration
   */
  static validateConfig(config: RemoteAgentConfig): void {
    if (!config.endpoint) {
      throw new Error("Remote agent endpoint is required");
    }

    if (!config.protocol) {
      throw new Error("Remote agent protocol is required");
    }

    if (!["acp", "mcp"].includes(config.protocol)) {
      throw new Error(`Unsupported protocol: ${config.protocol}`);
    }

    // Protocol-specific validation
    switch (config.protocol) {
      case "acp":
        if (!config.acp?.agent_name) {
          throw new Error("ACP agent_name is required for ACP protocol");
        }
        break;
      case "mcp":
        // MCP doesn't require specific fields beyond endpoint
        // Optional tools filtering can be configured
        break;
    }

    // Validate authentication if present
    if (config.auth) {
      this.validateAuthConfig(config.auth);
    }
  }

  /**
   * Validate authentication configuration
   */
  private static validateAuthConfig(auth: RemoteAgentConfig["auth"]): void {
    if (!auth) return;

    switch (auth.type) {
      case "bearer":
        if (!auth.token_env && !auth.token) {
          throw new Error("Bearer auth requires either token_env or token");
        }
        break;
      case "api_key":
        if (!auth.api_key_env && !auth.api_key && !auth.token_env) {
          throw new Error("API key auth requires api_key_env, api_key, or token_env");
        }
        break;
      case "basic":
        if (!auth.username || !auth.password) {
          throw new Error("Basic auth requires username and password");
        }
        break;
      case "none":
        // No validation needed
        break;
      default:
        throw new Error(`Unsupported auth type: ${auth.type}`);
    }
  }

  /**
   * Get supported protocols
   */
  static getSupportedProtocols(): RemoteProtocol[] {
    return ["acp", "mcp"];
  }

  /**
   * Check if protocol is supported
   */
  static isProtocolSupported(protocol: string): protocol is RemoteProtocol {
    return this.getSupportedProtocols().includes(protocol as RemoteProtocol);
  }
}
