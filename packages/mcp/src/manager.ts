/**
 * MCP Manager using Vercel AI SDK's experimental MCP client
 * Provides type-safe MCP server connectivity with transport abstraction
 */
import {
  type MCPAuthConfig,
  MCPAuthConfigSchema,
  type MCPToolsConfig,
  MCPToolsConfigSchema,
  MCPTransportConfigSchema,
} from "@atlas/config";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Span } from "@opentelemetry/api";
import { experimental_createMCPClient as createMCPClient } from "ai";
import { Experimental_StdioMCPTransport as StdioMCPTransport } from "ai/mcp-stdio";
import { z } from "zod/v4";
import { logger } from "../../../src/utils/logger.ts";
import { AtlasTelemetry } from "../../../src/utils/telemetry.ts";

// ai doesn't export the MCPClient type, so we need to infer it.
type MCPClient = Awaited<ReturnType<typeof createMCPClient>>;

// Extended MCP server config schema for internal use
export const MCPServerConfigSchema = z.object({
  id: z.string(),
  transport: MCPTransportConfigSchema,
  auth: MCPAuthConfigSchema.optional(),
  tools: MCPToolsConfigSchema.optional(),
  timeout_ms: z.number().positive().optional().default(30000),
  scope: z.enum(["platform", "workspace", "merged"]).optional(),
});

// Infer TypeScript type from extended schema
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
    return await AtlasTelemetry.withMCPSpan(
      config.id,
      "initialize",
      async (span) => {
        return await this._registerServerInternal(config, span);
      },
      {
        serverName: config.id,
      },
    );
  }

  private async _registerServerInternal(
    config: Omit<MCPServerConfig, "timeout_ms"> & { timeout_ms?: number },
    span: Span | null,
  ): Promise<void> {
    try {
      // Validate configuration with Zod schema
      const validatedConfig = MCPServerConfigSchema.parse(config);

      // Add telemetry attributes
      span?.setAttribute("mcp.transport_type", validatedConfig.transport.type);
      span?.setAttribute("mcp.timeout_ms", validatedConfig.timeout_ms);
      span?.setAttribute("mcp.has_auth", !!validatedConfig.auth);
      span?.setAttribute("mcp.scope", validatedConfig.scope || "workspace");

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
          const { command, args, env } = validatedConfig.transport;

          // Process environment variables and resolve "auto" values
          const processedEnv: Record<string, string> = {};
          if (env) {
            logger.debug(`Processing environment variables for MCP server: ${config.id}`, {
              operation: "mcp_env_setup",
              serverId: config.id,
              envConfig: env,
            });
            for (const [key, value] of Object.entries(env)) {
              if (value === "auto" || value === "from_environment") {
                // Read the actual environment variable
                const envValue = Deno.env.get(key);
                logger.debug(
                  `Looking up environment variable: ${key} = ${envValue ? "FOUND" : "NOT_FOUND"}`,
                  {
                    operation: "mcp_env_setup",
                    serverId: config.id,
                    envVar: key,
                    found: !!envValue,
                  },
                );
                if (envValue) {
                  processedEnv[key] = envValue;
                  logger.debug(`Using environment variable for MCP server: ${key}`, {
                    operation: "mcp_env_setup",
                    serverId: config.id,
                    envVar: key,
                  });
                } else {
                  logger.warn(`Environment variable not found: ${key}`, {
                    operation: "mcp_env_setup",
                    serverId: config.id,
                    envVar: key,
                  });
                }
              } else {
                processedEnv[key] = String(value);
              }
            }
          }

          mcpClient = await createMCPClient({
            transport: new StdioMCPTransport({
              command,
              args: args || [],
              env: processedEnv,
            }),
          });
          break;
        }

        case "http": {
          const { url } = validatedConfig.transport;

          // Create client with StreamableHTTPClientTransport
          const transport = new StreamableHTTPClientTransport(
            new URL(url),
          );

          mcpClient = await createMCPClient({
            transport,
          });
          break;
        }
      }

      // Verify the connection is actually working before marking as connected
      const isConnected = await this.verifyConnection(
        mcpClient,
        config.id,
        validatedConfig.transport.type,
      );

      this.clients.set(config.id, {
        client: mcpClient,
        config: validatedConfig,
        connected: isConnected,
      });

      // Add success telemetry attributes
      span?.setAttribute("mcp.registration_success", true);
      span?.setAttribute("mcp.client_connected", isConnected);

      logger.info(`MCP server registered: ${config.id} (connected: ${isConnected})`, {
        operation: "mcp_server_registration",
        serverId: config.id,
        transport: validatedConfig.transport.type,
        connected: isConnected,
        success: true,
      });
    } catch (error) {
      // Add error telemetry attributes
      span?.setAttribute("mcp.registration_success", false);
      span?.setAttribute("mcp.error_type", error instanceof Error ? error.name : "Unknown");
      span?.setAttribute(
        "mcp.error_message",
        error instanceof Error ? error.message : String(error),
      );

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
    return await AtlasTelemetry.withMCPSpan(
      serverIds.join(","),
      "tool_call",
      async (span) => {
        return await this._getToolsForServersInternal(serverIds, span);
      },
      {
        serverNames: serverIds,
        serversCount: serverIds.length,
      },
    );
  }

  private async _getToolsForServersInternal(
    serverIds: string[],
    span: Span | null,
  ): Promise<Record<string, unknown>> {
    const allTools: Record<string, unknown> = {};

    // Add telemetry attributes
    span?.setAttribute("mcp.requested_servers_count", serverIds.length);
    span?.setAttribute("mcp.requested_server_names", serverIds);

    let availableServersCount = 0;
    let successfulRetrievals = 0;

    for (const serverId of serverIds) {
      const wrapper = this.clients.get(serverId);
      if (!wrapper) {
        logger.warn(`MCP server not found in registry: ${serverId}`, {
          operation: "mcp_tools_retrieval",
          serverId,
          available: false,
        });
        continue;
      }

      // If not connected, try to re-verify connection once
      if (!wrapper.connected) {
        logger.debug(`MCP server not connected, attempting re-verification: ${serverId}`, {
          operation: "mcp_tools_retrieval",
          serverId,
          reconnecting: true,
        });

        const isNowConnected = await this.verifyConnection(
          wrapper.client,
          serverId,
          wrapper.config.transport.type,
        );

        // Update connection status
        wrapper.connected = isNowConnected;

        if (!isNowConnected) {
          logger.warn(`MCP server not available after re-verification: ${serverId}`, {
            operation: "mcp_tools_retrieval",
            serverId,
            available: false,
          });
          continue;
        } else {
          logger.info(`MCP server reconnected successfully: ${serverId}`, {
            operation: "mcp_tools_retrieval",
            serverId,
            reconnected: true,
          });
        }
      }

      availableServersCount++;

      try {
        // Get tools directly from AI SDK MCP client
        const tools = await wrapper.client.tools();

        // Debug log the first tool structure
        const toolNames = Object.keys(tools);
        if (toolNames.length > 0) {
          const firstToolName = toolNames[0];
          const firstTool = tools[firstToolName];
          logger.debug(`MCP tool structure for ${serverId}`, {
            operation: "mcp_tool_structure_debug",
            serverId,
            firstToolName,
            firstToolType: typeof firstTool,
            firstToolKeys: firstTool && typeof firstTool === "object" ? Object.keys(firstTool) : [],
            hasParameters: firstTool && typeof firstTool === "object" && "parameters" in firstTool,
            hasInputSchema: firstTool && typeof firstTool === "object" &&
              "input_schema" in firstTool,
          });
        }

        // Apply tool filtering and conversion
        const filteredTools = this.filterTools(tools, wrapper.config.tools);

        // Add to combined tools object
        Object.assign(allTools, filteredTools);

        successfulRetrievals++;

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

    // Add final telemetry attributes
    span?.setAttribute("mcp.available_servers_count", availableServersCount);
    span?.setAttribute("mcp.successful_retrievals_count", successfulRetrievals);
    span?.setAttribute("mcp.total_tools_retrieved", Object.keys(allTools).length);
    span?.setAttribute(
      "mcp.retrieval_success_rate",
      serverIds.length > 0 ? successfulRetrievals / serverIds.length : 0,
    );

    if (Object.keys(allTools).length > 0) {
      span?.setAttribute("mcp.tool_names", Object.keys(allTools));
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
   * Filters tools based on allowed/denied configuration and converts to AI SDK format
   * @param tools Raw tools object from MCP server
   * @param filterConfig Tool filtering configuration
   * @returns Filtered and converted tools object
   */
  private filterTools(
    tools: Record<string, unknown>,
    filterConfig?: MCPToolsConfig,
  ): Record<string, unknown> {
    const filtered: Record<string, unknown> = {};

    for (const [toolName, tool] of Object.entries(tools)) {
      // Apply allowed list
      if (filterConfig?.allowed && !filterConfig.allowed.includes(toolName)) {
        continue;
      }

      // Apply denied list
      if (filterConfig?.denied && filterConfig.denied.includes(toolName)) {
        continue;
      }

      // Convert MCP tool format to AI SDK format if needed
      // MCP tools may have 'parameters' but AI SDK expects 'input_schema'
      if (tool && typeof tool === "object" && "parameters" in tool && !("input_schema" in tool)) {
        // Create a new tool object with input_schema instead of parameters
        const toolObj = tool as Record<string, unknown>;
        const convertedTool = {
          ...toolObj,
          input_schema: toolObj.parameters,
        };
        // Remove the original parameters property to avoid confusion
        delete convertedTool.parameters;
        filtered[toolName] = convertedTool;
      } else {
        filtered[toolName] = tool;
      }
    }

    logger.debug("Applied tool filtering and conversion", {
      operation: "mcp_tool_filtering",
      originalCount: Object.keys(tools).length,
      filteredCount: Object.keys(filtered).length,
      allowedList: filterConfig?.allowed,
      deniedList: filterConfig?.denied,
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
    const serverIds = Array.from(this.clients.keys());

    return await AtlasTelemetry.withMCPSpan(
      "dispose-all",
      "cleanup",
      async (span) => {
        return await this._disposeInternal(serverIds, span);
      },
      {
        serversCount: serverIds.length,
        serverNames: serverIds,
      },
    );
  }

  private async _disposeInternal(serverIds: string[], span: Span | null): Promise<void> {
    // Add telemetry attributes
    span?.setAttribute("mcp.disposal_servers_count", serverIds.length);
    span?.setAttribute("mcp.disposal_server_names", serverIds);

    const closePromises = serverIds.map((serverId) => this.closeServer(serverId));

    const results = await Promise.allSettled(closePromises);
    this.clients.clear();

    // Count successful disposals
    const successfulDisposals = results.filter((result) => result.status === "fulfilled").length;
    const failedDisposals = results.length - successfulDisposals;

    // Add telemetry metrics
    span?.setAttribute("mcp.successful_disposals", successfulDisposals);
    span?.setAttribute("mcp.failed_disposals", failedDisposals);
    span?.setAttribute(
      "mcp.disposal_success_rate",
      serverIds.length > 0 ? successfulDisposals / serverIds.length : 1,
    );

    // Additional cleanup time for any lingering processes
    await new Promise((resolve) => setTimeout(resolve, 300));

    logger.info("MCP Manager disposed all resources", {
      operation: "mcp_manager_disposal",
      serversDisposed: closePromises.length,
      successfulDisposals,
      failedDisposals,
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

  /**
   * Verify that an MCP client is actually connected and can communicate
   */
  private async verifyConnection(
    client: MCPClient,
    serverId: string,
    transportType: string,
  ): Promise<boolean> {
    try {
      // For stdio transports, give the process time to start up
      if (transportType === "stdio") {
        logger.debug(`Waiting for stdio MCP server to initialize: ${serverId}`, {
          operation: "mcp_connection_verification",
          serverId,
          transportType,
        });

        // Wait up to 5 seconds for stdio process to be ready
        const maxRetries = 10;
        const retryDelay = 500; // 500ms between retries

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
          try {
            // Try to get tools as a connection test
            const _tools = await Promise.race([
              client.tools(),
              new Promise((_, reject) =>
                setTimeout(() => reject(new Error("Connection verification timeout")), 2000)
              ),
            ]);

            logger.info(`MCP server connection verified: ${serverId}`, {
              operation: "mcp_connection_verification",
              serverId,
              transportType,
              attempt,
              success: true,
            });

            return true;
          } catch (error) {
            logger.debug(
              `MCP server connection attempt ${attempt}/${maxRetries} failed: ${serverId}`,
              {
                operation: "mcp_connection_verification",
                serverId,
                transportType,
                attempt,
                error: error instanceof Error ? error.message : String(error),
              },
            );

            if (attempt < maxRetries) {
              await new Promise((resolve) => setTimeout(resolve, retryDelay));
            }
          }
        }

        logger.warn(
          `MCP server connection verification failed after ${maxRetries} attempts: ${serverId}`,
          {
            operation: "mcp_connection_verification",
            serverId,
            transportType,
            success: false,
          },
        );

        return false;
      } else {
        // For SSE and other transports, try immediate verification
        try {
          await Promise.race([
            client.tools(),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error("Connection verification timeout")), 3000)
            ),
          ]);

          logger.info(`MCP server connection verified: ${serverId}`, {
            operation: "mcp_connection_verification",
            serverId,
            transportType,
            success: true,
          });

          return true;
        } catch (error) {
          logger.warn(`MCP server connection verification failed: ${serverId}`, {
            operation: "mcp_connection_verification",
            serverId,
            transportType,
            error: error instanceof Error ? error.message : String(error),
            success: false,
          });

          return false;
        }
      }
    } catch (error) {
      logger.error(`MCP server connection verification error: ${serverId}`, {
        operation: "mcp_connection_verification",
        serverId,
        transportType,
        error: error instanceof Error ? error.message : String(error),
        success: false,
      });

      return false;
    }
  }
}
