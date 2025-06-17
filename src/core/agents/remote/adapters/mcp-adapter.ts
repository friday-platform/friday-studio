/**
 * MCP (Model Context Protocol) adapter for remote agent communication
 * Implements MCP protocol using the official TypeScript SDK
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema, ListToolsResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { BaseRemoteAdapter, type BaseRemoteAdapterConfig } from "./base-remote-adapter.ts";
import type {
  HealthStatus,
  RemoteAgentInfo,
  RemoteExecutionEvent,
  RemoteExecutionRequest,
  RemoteExecutionResult,
  RemoteMessagePart,
} from "../types.ts";
import { logger } from "../../../../utils/logger.ts";

export interface MCPAdapterConfig extends BaseRemoteAdapterConfig {
  timeout_ms?: number;
  allowed_tools?: string[];
  denied_tools?: string[];
}

export class MCPAdapter extends BaseRemoteAdapter {
  getProtocolName(): string {
    return "mcp";
  }
  private client: Client;
  private transport: StreamableHTTPClientTransport;
  private mcpConfig: MCPAdapterConfig;
  private mcpLogger = logger.createChildLogger({ component: "MCPAdapter" });
  private connected = false;
  private tools: Array<{ name: string; description?: string; inputSchema?: unknown }> = [];

  constructor(config: MCPAdapterConfig) {
    super(config);
    this.mcpConfig = config;

    // Create MCP client
    this.client = new Client(
      {
        name: "atlas-mcp-client",
        version: "1.0.0",
      },
      {
        capabilities: {},
      },
    );

    // Create HTTP transport
    this.transport = new StreamableHTTPClientTransport(
      new URL(config.connection.endpoint),
    );
  }

  async connect(): Promise<void> {
    if (this.connected) return;

    try {
      await this.client.connect(this.transport);
      this.connected = true;
      this.mcpLogger.info("Connected to MCP server", {
        endpoint: this.mcpConfig.connection.endpoint,
      });

      // Cache available tools on connect
      await this.loadTools();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.mcpLogger.error("Failed to connect to MCP server", {
        error: errorMessage,
        endpoint: this.mcpConfig.connection.endpoint,
      });
      throw new Error(`MCP connection failed: ${errorMessage}`);
    }
  }

  async discoverAgents(): Promise<RemoteAgentInfo[]> {
    await this.connect();

    try {
      return [
        {
          name: "mcp-server",
          description: `MCP Server with ${this.tools.length} tools`,
          version: "1.0.0",
          capabilities: this.tools.map((t) => t.name),
          supported_modes: ["sync"],
          metadata: {
            tools: this.tools.map((t) => ({
              name: t.name,
              description: t.description,
            })),
            endpoint: this.mcpConfig.connection.endpoint,
            protocol: "mcp",
          },
        },
      ];
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.mcpLogger.error("Failed to discover MCP agents", {
        error: errorMessage,
      });
      throw new Error(`MCP discovery failed: ${errorMessage}`);
    }
  }

  async getAgentDetails(agentName: string): Promise<RemoteAgentInfo> {
    const agents = await this.discoverAgents();
    const agent = agents.find((a) => a.name === agentName);
    if (!agent) {
      throw new Error(`Agent not found: ${agentName}`);
    }
    return agent;
  }

  async executeAgent(
    request: RemoteExecutionRequest,
  ): Promise<RemoteExecutionResult> {
    await this.connect();

    const startTime = performance.now();
    const executionId = crypto.randomUUID();

    try {
      const toolCall = this.parseToolCall(request.input);

      // Check tool filtering
      if (
        this.mcpConfig.allowed_tools &&
        !this.mcpConfig.allowed_tools.includes(toolCall.name)
      ) {
        throw new Error(
          `Tool '${toolCall.name}' not in allowed tools list`,
        );
      }

      if (
        this.mcpConfig.denied_tools &&
        this.mcpConfig.denied_tools.includes(toolCall.name)
      ) {
        throw new Error(`Tool '${toolCall.name}' is denied by configuration`);
      }

      // Verify tool exists
      if (!this.tools.find((t) => t.name === toolCall.name)) {
        throw new Error(`Tool '${toolCall.name}' not available on MCP server`);
      }

      const result = await this.client.request(
        {
          method: "tools/call",
          params: {
            name: toolCall.name,
            arguments: toolCall.arguments,
          },
        },
        CallToolResultSchema,
      );

      const executionTime = performance.now() - startTime;

      return {
        executionId,
        output: result.content.map((c): RemoteMessagePart => ({
          content_type: c.type === "text" ? "text/plain" : "application/json",
          content: c.type === "text" ? c.text : JSON.stringify(c),
        })),
        status: result.isError ? "failed" : "completed",
        error: result.isError ? "Tool execution failed" : undefined,
        metadata: {
          execution_time_ms: executionTime,
          agent_version: "1.0.0",
          session_id: request.sessionId,
          model_used: toolCall.name,
          performance: {
            processing_time_ms: executionTime,
          },
        },
      };
    } catch (error) {
      const executionTime = performance.now() - startTime;

      const errorMessage = error instanceof Error ? error.message : String(error);
      this.mcpLogger.error("MCP tool execution failed", {
        executionId,
        error: errorMessage,
        agentName: request.agentName,
      });

      return {
        executionId,
        output: [],
        status: "failed",
        error: errorMessage,
        metadata: {
          execution_time_ms: executionTime,
          session_id: request.sessionId,
          performance: {
            processing_time_ms: executionTime,
          },
        },
      };
    }
  }

  async *executeAgentStream(
    request: RemoteExecutionRequest,
  ): AsyncIterableIterator<RemoteExecutionEvent> {
    // MCP doesn't support streaming by default, so we'll execute synchronously
    // and yield the result as a single event
    try {
      const result = await this.executeAgent(request);

      // Convert result to stream event
      yield {
        type: "completion",
        status: result.status,
        output: result.output,
        error: result.error,
        metadata: result.metadata as unknown as Record<string, unknown>,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      yield {
        type: "error",
        error: errorMessage,
      };
    }
  }

  cancelExecution(executionId: string): Promise<void> {
    // MCP doesn't have built-in cancellation support
    this.mcpLogger.warn("MCP execution cancellation not supported", {
      executionId,
    });
    return Promise.reject(new Error("Execution cancellation not supported by MCP protocol"));
  }

  resumeExecution(
    executionId: string,
    _response: string | RemoteMessagePart[],
  ): Promise<RemoteExecutionResult> {
    // MCP doesn't support resuming executions
    this.mcpLogger.warn("MCP execution resumption not supported", {
      executionId,
    });
    return Promise.reject(new Error("Execution resumption not supported by MCP protocol"));
  }

  async healthCheck(): Promise<HealthStatus> {
    try {
      const startTime = performance.now();
      await this.connect();

      // Simple health check by listing tools
      await this.client.request(
        {
          method: "tools/list",
          params: {},
        },
        ListToolsResultSchema,
      );

      const latency = performance.now() - startTime;

      return {
        status: "healthy",
        latency_ms: latency,
        capabilities: this.tools.map((t) => t.name),
        last_check: new Date(),
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.mcpLogger.error("MCP health check failed", {
        error: errorMessage,
      });
      return {
        status: "unhealthy",
        error: errorMessage,
        last_check: new Date(),
      };
    }
  }

  private async loadTools(): Promise<void> {
    try {
      const toolsResult = await this.client.request(
        {
          method: "tools/list",
          params: {},
        },
        ListToolsResultSchema,
      );

      this.tools = toolsResult.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      }));

      this.mcpLogger.info("Loaded MCP tools", {
        toolCount: this.tools.length,
        tools: this.tools.map((t) => t.name),
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.mcpLogger.error("Failed to load MCP tools", {
        error: errorMessage,
      });
      this.tools = [];
    }
  }

  private parseToolCall(
    input: string | RemoteMessagePart[],
  ): { name: string; arguments: Record<string, unknown> } {
    const inputStr = typeof input === "string" ? input : input[0]?.content?.toString() || "";

    try {
      // Try to parse as JSON
      const parsed = JSON.parse(inputStr);
      return {
        name: parsed.name || parsed.tool || "unknown",
        arguments: parsed.arguments || parsed.args || {},
      };
    } catch {
      // Fallback: treat entire input as tool name
      return {
        name: inputStr.trim(),
        arguments: {},
      };
    }
  }

  override async dispose(): Promise<void> {
    try {
      if (this.connected && this.transport) {
        await this.transport.close();
        this.connected = false;
        this.mcpLogger.info("Disconnected from MCP server");
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.mcpLogger.error("Error during MCP adapter disposal", {
        error: errorMessage,
      });
    }
  }
}
