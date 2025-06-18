/**
 * MCP Manager using Vercel AI SDK's experimental MCP client
 * Provides type-safe MCP server connectivity with transport abstraction
 */
import { experimental_createMCPClient as createMCPClient } from "ai";
import { Experimental_StdioMCPTransport as StdioMCPTransport } from "ai/mcp-stdio";
import { z } from "zod";
import { logger } from "../../../utils/logger.ts";

// ai doesn't export the MCPClient type, so we need to infer it.
type MCPClient = Awaited<ReturnType<typeof createMCPClient>>;

// Zod schemas for type-safe configuration
export const MCPTransportConfigSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("sse"),
    url: z.string().url(),
  }).strict(),
  z.object({
    type: z.literal("stdio"),
    command: z.string(),
    args: z.array(z.string()).optional(),
  }).strict(),
]);

export const MCPAuthConfigSchema = z.object({
  type: z.enum(["bearer", "api_key"]),
  token_env: z.string().optional(),
  header: z.string().optional(),
});

export const MCPToolsConfigSchema = z.object({
  allowed: z.array(z.string()).optional(),
  denied: z.array(z.string()).optional(),
});

export const MCPServerConfigSchema = z.object({
  id: z.string(),
  transport: MCPTransportConfigSchema,
  auth: MCPAuthConfigSchema.optional(),
  tools: MCPToolsConfigSchema.optional(),
  timeout_ms: z.number().positive().optional().default(30000),
  scope: z.enum(["platform", "workspace", "merged"]).optional(),
});

// Infer TypeScript types from Zod schemas
export type MCPTransportConfig = z.infer<typeof MCPTransportConfigSchema>;
export type MCPAuthConfig = z.infer<typeof MCPAuthConfigSchema>;
export type MCPToolsConfig = z.infer<typeof MCPToolsConfigSchema>;
export type MCPServerConfig = z.infer<typeof MCPServerConfigSchema>;

interface MCPClientWrapper {
  client: MCPClient;
  config: MCPServerConfig;
  connected: boolean;
}

/**
 * MCP Manager using Vercel AI SDK's native MCP client
 * Handles connection management, tool filtering, and lifecycle management
 */
export class MCPManager {
  private clients: Map<string, MCPClientWrapper> = new Map();

  /**
   * Registers an MCP server using AI SDK's MCP client
   * @param config MCP server configuration
   */
  async registerServer(
    config: Omit<MCPServerConfig, "timeout_ms"> & { timeout_ms?: number },
  ): Promise<void> {
    try {
      // Validate configuration with Zod schema
      const validatedConfig = MCPServerConfigSchema.parse(config);

      // Create AI SDK MCP client
      let mcpClient: MCPClient;

      logger.info(`Registering MCP server: ${config.id}`, {
        operation: "mcp_server_registration",
        serverId: config.id,
        transport: config.transport.type,
      });

      // Create client based on transport type
      switch (validatedConfig.transport.type) {
        case "sse": {
          const { url } = validatedConfig.transport;
          mcpClient = await createMCPClient({
            transport: {
              type: "sse",
              url,
              headers: this.buildAuthHeaders(validatedConfig.auth),
            },
          });
          break;
        }

        case "stdio": {
          const { command, args } = validatedConfig.transport;
          mcpClient = await createMCPClient({
            transport: new StdioMCPTransport({
              command,
              args: args || [],
            }),
          });
          break;
        }
      }

      this.clients.set(config.id, {
        client: mcpClient,
        config: validatedConfig,
        connected: true,
      });

      logger.info(`MCP server registered successfully: ${config.id}`, {
        operation: "mcp_server_registration",
        serverId: config.id,
        transport: validatedConfig.transport.type,
        success: true,
      });
    } catch (error) {
      logger.error(`Failed to register MCP server: ${config.id}`, {
        operation: "mcp_server_registration",
        serverId: config.id,
        error: error instanceof Error ? error.message : String(error),
        transport: config.transport,
      });
      throw new Error(
        `MCP server registration failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Gets tools from specified MCP servers with filtering applied
   * @param serverIds Array of server IDs to get tools from
   * @returns Promise<Record<string, unknown>> Combined tools object
   */
  async getToolsForServers(serverIds: string[]): Promise<Record<string, unknown>> {
    const allTools: Record<string, unknown> = {};

    for (const serverId of serverIds) {
      const wrapper = this.clients.get(serverId);
      if (!wrapper || !wrapper.connected) {
        logger.warn(`MCP server not available: ${serverId}`, {
          operation: "mcp_tools_retrieval",
          serverId,
          available: false,
        });
        continue;
      }

      try {
        // Get tools directly from AI SDK MCP client
        const tools = await wrapper.client.tools();

        // Apply tool filtering
        const filteredTools = this.filterTools(tools, wrapper.config.tools);

        // Add to combined tools object
        Object.assign(allTools, filteredTools);

        logger.debug(
          `Loaded ${Object.keys(filteredTools).length} tools from ${serverId}`,
          {
            operation: "mcp_tools_retrieval",
            serverId,
            toolCount: Object.keys(filteredTools).length,
            toolNames: Object.keys(filteredTools),
          },
        );
      } catch (error) {
        logger.error(`Failed to load tools from MCP server: ${serverId}`, {
          operation: "mcp_tools_retrieval",
          serverId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    logger.debug(`Retrieved tools from ${serverIds.length} MCP servers`, {
      operation: "mcp_tools_retrieval",
      serverIds,
      totalToolCount: Object.keys(allTools).length,
      toolNames: Object.keys(allTools),
    });

    return allTools;
  }

  /**
   * Filters tools based on allowed/denied configuration
   * @param tools Raw tools object from MCP server
   * @param filterConfig Tool filtering configuration
   * @returns Filtered tools object
   */
  private filterTools(
    tools: Record<string, unknown>,
    filterConfig?: MCPToolsConfig,
  ): Record<string, unknown> {
    if (!filterConfig) return tools;

    const filtered: Record<string, unknown> = {};

    for (const [toolName, tool] of Object.entries(tools)) {
      // Apply allowed list
      if (filterConfig.allowed && !filterConfig.allowed.includes(toolName)) {
        continue;
      }

      // Apply denied list
      if (filterConfig.denied && filterConfig.denied.includes(toolName)) {
        continue;
      }

      filtered[toolName] = tool;
    }

    logger.debug("Applied tool filtering", {
      operation: "mcp_tool_filtering",
      originalCount: Object.keys(tools).length,
      filteredCount: Object.keys(filtered).length,
      allowedList: filterConfig.allowed,
      deniedList: filterConfig.denied,
      filteredTools: Object.keys(filtered),
    });

    return filtered;
  }

  /**
   * Builds authentication headers for MCP server requests
   * @param auth Authentication configuration
   * @returns Headers object
   */
  private buildAuthHeaders(auth?: MCPAuthConfig): Record<string, string> {
    const headers: Record<string, string> = {};

    if (!auth) return headers;

    if (auth.type === "bearer" && auth.token_env) {
      const token = Deno.env.get(auth.token_env);
      if (token) {
        headers["Authorization"] = `Bearer ${token}`;
        logger.debug("Added bearer token authentication", {
          operation: "mcp_auth_headers",
          authType: "bearer",
          tokenEnv: auth.token_env,
        });
      } else {
        logger.warn(`Bearer token environment variable not found: ${auth.token_env}`, {
          operation: "mcp_auth_headers",
          authType: "bearer",
          tokenEnv: auth.token_env,
        });
      }
    }

    if (auth.type === "api_key" && auth.token_env) {
      const apiKey = Deno.env.get(auth.token_env);
      if (apiKey) {
        headers[auth.header || "X-API-Key"] = apiKey;
        logger.debug("Added API key authentication", {
          operation: "mcp_auth_headers",
          authType: "api_key",
          tokenEnv: auth.token_env,
          header: auth.header || "X-API-Key",
        });
      } else {
        logger.warn(`API key environment variable not found: ${auth.token_env}`, {
          operation: "mcp_auth_headers",
          authType: "api_key",
          tokenEnv: auth.token_env,
        });
      }
    }

    return headers;
  }

  /**
   * Closes a specific MCP server connection
   * @param serverId Server ID to close
   */
  async closeServer(serverId: string): Promise<void> {
    const wrapper = this.clients.get(serverId);
    if (!wrapper) return;

    try {
      // Try to get access to the underlying process if it exists
      const client = wrapper.client;

      // Close the client connection
      await client.close();

      // Give processes time to terminate
      await new Promise((resolve) => setTimeout(resolve, 200));

      wrapper.connected = false;

      logger.debug(`Closed MCP server: ${serverId}`, {
        operation: "mcp_server_closure",
        serverId,
        success: true,
      });
    } catch (error) {
      logger.warn(`Error closing MCP server: ${serverId}`, {
        operation: "mcp_server_closure",
        serverId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Disposes all MCP client resources
   */
  async dispose(): Promise<void> {
    const closePromises = Array.from(this.clients.keys()).map((serverId) =>
      this.closeServer(serverId)
    );

    await Promise.allSettled(closePromises);
    this.clients.clear();

    // Additional cleanup time for any lingering processes
    await new Promise((resolve) => setTimeout(resolve, 300));

    logger.info("MCP Manager disposed all resources", {
      operation: "mcp_manager_disposal",
      serversDisposed: closePromises.length,
    });
  }

  /**
   * Gets the status of all registered MCP servers
   * @returns Map of server IDs to their connection status
   */
  getServerStatus(): Map<string, boolean> {
    const status = new Map<string, boolean>();
    for (const [serverId, wrapper] of this.clients) {
      status.set(serverId, wrapper.connected);
    }
    return status;
  }

  /**
   * Gets the configuration for a specific MCP server
   * @param serverId Server ID
   * @returns Server configuration or undefined
   */
  getServerConfig(serverId: string): MCPServerConfig | undefined {
    const wrapper = this.clients.get(serverId);
    return wrapper?.config;
  }

  /**
   * Lists all registered server IDs
   * @returns Array of server IDs
   */
  listServers(): string[] {
    return Array.from(this.clients.keys());
  }
}
