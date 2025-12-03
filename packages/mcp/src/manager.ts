/**
 * MCP Manager using Vercel AI SDK's experimental MCP client
 * Provides type-safe MCP server connectivity with transport abstraction
 */

import { experimental_createMCPClient as createMCPClient } from "@ai-sdk/mcp";
import { Experimental_StdioMCPTransport as StdioMCPTransport } from "@ai-sdk/mcp/mcp-stdio";
import {
  type MCPAuthConfig,
  MCPAuthConfigSchema,
  type MCPServerToolFilter,
  MCPServerToolFilterSchema,
  MCPTransportConfigSchema,
} from "@atlas/config";
import { logger } from "@atlas/logger";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Span } from "@opentelemetry/api";
import type { Tool } from "ai";
import { z } from "zod";
import { AtlasTelemetry } from "../../../src/utils/telemetry.ts";

// ai doesn't export the MCPClient type, so we need to infer it.
type MCPClient = Awaited<ReturnType<typeof createMCPClient>>;

// Extended MCP server config schema for internal use
export const MCPServerConfigSchema = z.object({
  id: z.string(),
  transport: MCPTransportConfigSchema,
  auth: MCPAuthConfigSchema.optional(),
  tools: MCPServerToolFilterSchema.optional(),
  timeout_ms: z.number().positive().optional().default(30000),
  scope: z.enum(["platform", "workspace", "merged"]).optional(),
  env: z.record(z.string(), z.string()).optional(),
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
  private static instance: MCPManager = new MCPManager();
  private clients: Map<string, MCPClientWrapper> = new Map();

  /**
   * Get the singleton instance of MCPManager
   */
  static getInstance(): MCPManager {
    return MCPManager.instance;
  }

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
      { serverName: config.id },
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
            transport: { type: "sse", url, headers: this.buildAuthHeaders(validatedConfig.auth) },
          });
          break;
        }

        case "stdio": {
          let { command, args } = validatedConfig.transport;
          const env = validatedConfig.env;

          // Smart command resolution for npx
          // If command is 'npx' and we have ATLAS_NPX_PATH, use the full path
          if (command === "npx" || command === "npx.cmd") {
            const npxPath = Deno.env.get("ATLAS_NPX_PATH");
            if (npxPath) {
              // Validate the npx path exists and is executable
              try {
                // Follow symlinks to get the real path
                let realPath = npxPath;
                try {
                  realPath = await Deno.realPath(npxPath);
                  if (realPath !== npxPath) {
                    logger.debug(`Resolved npx symlink: ${npxPath} -> ${realPath}`, {
                      operation: "mcp_command_resolution",
                      serverId: config.id,
                    });
                  }
                } catch {
                  // Not a symlink or doesn't exist, use original path
                  realPath = npxPath;
                }

                const fileInfo = await Deno.stat(realPath);
                if (fileInfo.isFile) {
                  logger.debug(`Using configured npx path: ${npxPath}`, {
                    operation: "mcp_command_resolution",
                    serverId: config.id,
                    originalCommand: command,
                    resolvedCommand: npxPath,
                    realPath: realPath !== npxPath ? realPath : undefined,
                  });
                  command = npxPath; // Use original path, not realPath, for execution
                } else {
                  logger.warn(`Configured ATLAS_NPX_PATH is not a file: ${npxPath}`, {
                    operation: "mcp_command_resolution",
                    serverId: config.id,
                    realPath: realPath !== npxPath ? realPath : undefined,
                  });
                }
              } catch (error) {
                logger.warn(`Configured ATLAS_NPX_PATH does not exist: ${npxPath}`, {
                  operation: "mcp_command_resolution",
                  serverId: config.id,
                  error: error instanceof Error ? error.message : String(error),
                });
              }
            }

            // If still not resolved, try fallback locations
            if (command === "npx" || command === "npx.cmd") {
              // Fallback: Try to find npx in common locations
              const fallbackPaths =
                Deno.build.os === "windows"
                  ? [
                      "C:\\Program Files\\nodejs\\npx.cmd", // Windows default
                      "C:\\Program Files (x86)\\nodejs\\npx.cmd", // Windows 32-bit on 64-bit
                      "%APPDATA%\\npm\\npx.cmd", // Windows user install
                    ]
                  : [
                      "/opt/homebrew/bin/npx", // macOS with Homebrew
                      "/usr/local/bin/npx", // Common Unix location
                      "/usr/bin/npx", // System location
                      "/home/linuxbrew/.linuxbrew/bin/npx", // Linux Homebrew
                    ];

              for (const fallbackPath of fallbackPaths) {
                try {
                  // Expand environment variables on Windows
                  const expandedPath =
                    Deno.build.os === "windows"
                      ? fallbackPath.replace(/%([^%]+)%/g, (_, key) => Deno.env.get(key) || "")
                      : fallbackPath;

                  const fileInfo = await Deno.stat(expandedPath);
                  if (fileInfo.isFile) {
                    logger.info(`Found npx at fallback location: ${expandedPath}`, {
                      operation: "mcp_command_resolution",
                      serverId: config.id,
                    });
                    command = expandedPath;
                    break;
                  }
                } catch {
                  // Path doesn't exist, try next
                }
              }

              if (command === "npx" || command === "npx.cmd") {
                logger.warn(
                  `npx not found in configured or fallback locations, using system PATH`,
                  {
                    operation: "mcp_command_resolution",
                    serverId: config.id,
                    hint: "Consider setting ATLAS_NPX_PATH in ~/.atlas/.env",
                  },
                );
              }
            }
          }

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
                  throw new Error(
                    `Required environment variable '${key}' not found. ` +
                      `MCP server '${config.id}' requires this variable when env is set to "auto". ` +
                      `Set it in your workspace .env file or system environment.`,
                  );
                }
              } else {
                processedEnv[key] = String(value);
              }
            }
          }

          // Merge processed env vars with parent process env
          // Deno.Command replaces the environment if you pass the env option
          // We need to merge with parent to preserve PATH and other critical vars
          const parentEnv = Deno.env.toObject();
          const mergedEnv = { ...parentEnv, ...processedEnv };

          mcpClient = await createMCPClient({
            transport: new StdioMCPTransport({ command, args: args || [], env: mergedEnv }),
          });
          break;
        }

        case "http": {
          const { url } = validatedConfig.transport;

          // Create client with StreamableHTTPClientTransport with auth headers
          const transport = new StreamableHTTPClientTransport(new URL(url), {
            requestInit: {
              headers: this.buildAuthHeaders(validatedConfig.auth),
              // Add timeout for HTTP requests to prevent hanging
              signal: AbortSignal.timeout(5000), // 5 second timeout
            },
          });

          // Wrap createMCPClient in a timeout to prevent hanging
          mcpClient = await Promise.race([
            createMCPClient({ transport }),
            new Promise<never>((_, reject) =>
              setTimeout(
                () => reject(new Error(`HTTP MCP client creation timeout for ${config.id}`)),
                5000,
              ),
            ),
          ]);
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

      // For platform server connection issues, log at debug level (not critical)
      const isPlatformConnectionIssue =
        config.id === "atlas-platform" &&
        error instanceof Error &&
        (error.message.includes("timeout") || error.message.includes("connection"));

      if (isPlatformConnectionIssue) {
        logger.debug(`Platform MCP server temporarily unavailable: ${config.id}`, {
          operation: "mcp_server_registration",
          serverId: config.id,
          reason: error instanceof Error ? error.message : String(error),
          transport: config.transport,
        });
      } else {
        logger.error(`Failed to register MCP server: ${config.id}`, {
          operation: "mcp_server_registration",
          serverId: config.id,
          error: error instanceof Error ? error.message : String(error),
          transport: config.transport,
        });
      }

      // Build error message with transport context for debugging
      const msg = error instanceof Error ? error.message : String(error);
      let context = "";
      if (config.transport.type === "stdio") {
        const { command, args } = config.transport;
        context = ` (command: ${args?.length ? `${command} ${args.join(" ")}` : command})`;
      } else if (config.transport.type === "sse" || config.transport.type === "http") {
        context = ` (url: ${config.transport.url})`;
      }

      throw new Error(`MCP server '${config.id}' registration failed: ${msg}${context}`);
    }
  }

  /**
   * Gets tools from specified MCP servers with filtering applied
   * @param serverIds Array of server IDs to get tools from
   * @returns Promise<Record<string, unknown>> Combined tools object
   */
  async getToolsForServers(serverIds: string[]): Promise<Record<string, Tool>> {
    return await AtlasTelemetry.withMCPSpan(
      serverIds.join(","),
      "tool_call",
      async (span) => {
        return await this._getToolsForServersInternal(serverIds, span);
      },
      { serverNames: serverIds, serversCount: serverIds.length },
    );
  }

  private async _getToolsForServersInternal(
    serverIds: string[],
    span: Span | null,
  ): Promise<Record<string, Tool>> {
    const allTools: Record<string, Tool> = {};

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
        const tools = (await wrapper.client.tools()) as Record<string, Tool>;

        // Apply tool filtering and conversion
        const filteredTools = this.filterTools(tools, wrapper.config.tools);

        // Add to combined tools object
        Object.assign(allTools, filteredTools);

        successfulRetrievals++;

        logger.debug(`Loaded ${Object.keys(filteredTools).length} tools from ${serverId}`, {
          operation: "mcp_tools_retrieval",
          serverId,
          toolCount: Object.keys(filteredTools).length,
        });
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
    tools: Record<string, Tool>,
    filterConfig?: MCPServerToolFilter,
  ): Record<string, Tool> {
    const filtered: Record<string, Tool> = {};

    for (const [toolName, tool] of Object.entries(tools)) {
      // Apply allowed list
      if (filterConfig?.allow && !filterConfig.allow.includes(toolName)) {
        continue;
      }

      // Apply denied list
      if (filterConfig?.deny?.includes(toolName)) {
        continue;
      }

      // Convert MCP tool format to AI SDK format if needed
      // MCP tools may have 'parameters' but AI SDK expects 'inputSchema'
      if (tool && typeof tool === "object" && "parameters" in tool && !("inputSchema" in tool)) {
        // Create a new tool object with inputSchema instead of parameters
        // We destructure to exclude 'parameters' and rebuild with 'inputSchema'
        // @ts-expect-error TypeScript doesn't narrow the type properly after the type guard
        const { parameters, ...restTool } = tool;
        const convertedTool: Tool = { ...restTool, inputSchema: parameters };
        filtered[toolName] = convertedTool;
      } else {
        filtered[toolName] = tool;
      }
    }

    logger.debug("Applied tool filtering and conversion", {
      operation: "mcp_tool_filtering",
      originalCount: Object.keys(tools).length,
      filteredCount: Object.keys(filtered).length,
      allowedList: filterConfig?.allow,
      deniedList: filterConfig?.deny,
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
        headers.Authorization = `Bearer ${token}`;
        logger.debug("Added bearer token authentication", {
          operation: "mcp_auth_headers",
          authType: "bearer",
          tokenEnv: auth.token_env,
        });
      } else {
        throw new Error(
          `Required bearer token environment variable '${auth.token_env}' not found. ` +
            `Set it in your workspace .env file or system environment.`,
        );
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
        throw new Error(
          `Required API key environment variable '${auth.token_env}' not found. ` +
            `Set it in your workspace .env file or system environment.`,
        );
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
      { serversCount: serverIds.length, serverNames: serverIds },
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
            await Promise.race([
              client.tools(),
              new Promise((_, reject) =>
                setTimeout(() => reject(new Error("Connection verification timeout")), 2000),
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
          { operation: "mcp_connection_verification", serverId, transportType, success: false },
        );

        return false;
      } else {
        // For SSE and other transports, try immediate verification
        try {
          await Promise.race([
            client.tools(),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error("Connection verification timeout")), 3000),
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
          logger.fatal(`Failed to connect to MCP server: ${serverId}`, {
            operation: "mcp_connection_verification",
            serverId,
            transportType,
            error,
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

export const mcpManager = new MCPManager();
