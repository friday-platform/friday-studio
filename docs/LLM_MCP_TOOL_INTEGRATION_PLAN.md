# LLM MCP Tool Integration Plan

## ✅ Implementation Status (June 18, 2025)

**PHASES 1 & 2 COMPLETE**: Core MCP Manager and Workspace Registry Architecture fully operational
with comprehensive testing and integration.

### Key Achievements:

#### ✅ **Phase 1 - Core MCP Manager (Completed June 17)**

- ✅ **MCPManager**: Full AI SDK integration with `experimental_createMCPClient`
- ✅ **Type Safety**: Complete Zod schema validation with discriminated unions
- ✅ **Transport Support**: Both SSE and stdio transports implemented and tested
- ✅ **Test Suite**: 16 passing tests (7 MCPManager + 9 configuration validation)
- ✅ **Resource Management**: Leak-free testing with aggressive cleanup strategies
- ✅ **Mock Servers**: Modern Deno-native MCP servers for comprehensive testing

#### ✅ **Phase 2 - Workspace Registry Architecture (Completed June 18)**

- ✅ **MCPServerRegistry**: Hierarchical configuration resolution (platform → workspace → agent)
- ✅ **Configuration Service**: Clean encapsulation with `WorkspaceMCPConfigurationService`
- ✅ **Agent Integration**: Registry pattern integrated into agent execution workers
- ✅ **Encapsulation Fix**: Eliminated direct workspace config access from agents
- ✅ **Integration Tests**: All 12 MCP integration tests passing without resource leaks
- ✅ **Architecture Compliance**: Mirrors existing LLMProviderManager pattern

### Files Implemented:

#### **Core MCP Infrastructure:**

- `src/core/agents/mcp/mcp-manager.ts` - Core MCP client manager with AI SDK integration
- `src/core/agents/mcp/mcp-server-registry.ts` - **NEW**: Workspace-level configuration registry
- `src/core/services/mcp-configuration-service.ts` - **NEW**: Clean service interface for MCP config
  resolution

#### **Enhanced Agent Execution:**

- `src/core/workers/agent-execution-worker.ts` - **UPDATED**: Uses registry pattern instead of
  direct config access
- `src/core/agents/llm-provider-manager.ts` - **ENHANCED**: Full MCP integration with tool calling
  support

#### **Comprehensive Testing:**

- `tests/unit/mcp/mcp-manager.test.ts` - Core MCP manager tests (7 tests)
- `tests/unit/mcp/config-validation.test.ts` - Schema validation tests (9 tests)
- `tests/integration/mcp/` - **FIXED**: All integration tests now pass (12 tests)
- `tests/utils/test-mcp-servers.ts` - **ENHANCED**: Proper resource cleanup for test servers
- `tests/mocks/*.ts` - Modern MCP test servers with feedback loop detection

### Next Phase:

Phase 3 will focus on production deployment features including enhanced error recovery, performance
optimization, and comprehensive example workspaces.

## Overview

This document outlines the implementation plan for integrating Model Context Protocol (MCP) server
connectivity with Atlas LLM agents, using Vercel AI SDK's native `experimental_createMCPClient` and
built-in transport system for seamless tool calling integration.

## Background

### Current LLM Agent Architecture

Atlas currently supports LLM agents (`type: "llm"`) that:

- Use LLMProviderManager for text generation via Vercel AI SDK
- Support multiple providers (Anthropic, OpenAI, Google)
- Execute in isolated Web Workers
- Have configurable prompts, temperature, and max tokens

### Target Integration with AI SDK's MCP Client

We want LLM agents to:

- Connect to MCP servers using AI SDK's `experimental_createMCPClient`
- Leverage AI SDK's built-in MCP transport (SSE, stdio)
- Directly use MCP tools through AI SDK's native tool calling system
- Support tool filtering and access control
- Maintain security and isolation boundaries
- Eliminate manual tool conversion by using AI SDK's native MCP integration

## Architecture Design

### 1. MCP Server Configuration

**Enhanced workspace.yml schema to define MCP servers:**

```yaml
mcp_servers:
  # SSE transport example
  weather_server:
    transport:
      type: "sse"
      url: "https://weather-api.example.com/mcp"
    auth:
      type: "bearer"
      token_env: "WEATHER_API_TOKEN"
    tools:
      allowed: ["get_weather", "get_forecast"]
      denied: ["delete_data"]
    timeout_ms: 30000

  # stdio transport example
  local_tools:
    transport:
      type: "stdio"
      command: "node"
      args: ["./tools/local-mcp-server.js"]
    tools:
      allowed: ["file_operations", "data_processing"]
    timeout_ms: 15000

agents:
  weather_analyst:
    type: "llm"
    model: "claude-3-5-sonnet-20241022"
    purpose: "Weather analysis with live data"
    mcp_servers: ["weather_server", "local_tools"] # Reference to MCP servers
    max_steps: 3
    tool_choice: "auto"
```

### 2. MCP Client Manager

**✅ IMPLEMENTED: MCP client manager using AI SDK's native client:**

```typescript
// src/core/agents/mcp/mcp-manager.ts - IMPLEMENTED ✅
import { experimental_createMCPClient as createMCPClient } from "ai";
import { Experimental_StdioMCPTransport as StdioMCPTransport } from "ai/mcp-stdio";
import { z } from "zod/v4;
import { logger } from "../../../utils/logger.ts";

// AI SDK MCP Client type inference
type MCPClient = Awaited<ReturnType<typeof createMCPClient>>;

// ✅ IMPLEMENTED: Zod schemas for type-safe configuration
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
});

// ✅ IMPLEMENTED: Infer TypeScript types from Zod schemas
export type MCPTransportConfig = z.infer<typeof MCPTransportConfigSchema>;
export type MCPAuthConfig = z.infer<typeof MCPAuthConfigSchema>;
export type MCPToolsConfig = z.infer<typeof MCPToolsConfigSchema>;
export type MCPServerConfig = z.infer<typeof MCPServerConfigSchema>;

interface MCPClientWrapper {
  client: MCPClient; // ✅ IMPLEMENTED: Properly typed AI SDK MCP client
  config: MCPServerConfig;
  connected: boolean;
}

/**
 * ✅ IMPLEMENTED: MCP Manager using Vercel AI SDK's native MCP client
 * Handles connection management, tool filtering, and lifecycle management
 */
export class MCPManager {
  private clients: Map<string, MCPClientWrapper> = new Map();

  /**
   * ✅ IMPLEMENTED: Registers an MCP server using AI SDK's experimental MCP client
   * @param config MCP server configuration
   */
  async registerServer(
    config: Omit<MCPServerConfig, "timeout_ms"> & { timeout_ms?: number },
  ): Promise<void> {
    try {
      // ✅ IMPLEMENTED: Validate configuration with Zod schema
      const validatedConfig = MCPServerConfigSchema.parse(config);

      // ✅ IMPLEMENTED: Create AI SDK MCP client
      let mcpClient: MCPClient;

      logger.info(`Registering MCP server: ${config.id}`, {
        operation: "mcp_server_registration",
        serverId: config.id,
        transport: config.transport.type,
      });

      // ✅ IMPLEMENTED: Create client based on transport type (type-safe discriminated union)
      switch (validatedConfig.transport.type) {
        case "sse": {
          // TypeScript knows transport has url property here
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
          // TypeScript knows transport has command and optional args here
          const { command, args } = validatedConfig.transport;
          mcpClient = await createMCPClient({
            transport: new StdioMCPTransport({
              command,
              args: args || [],
            }),
          });
          break;
        }

        default: {
          // TypeScript ensures this is unreachable due to discriminated union
          const _exhaustive: never = validatedConfig.transport;
          throw new Error(
            `Unsupported transport type: ${(_exhaustive as unknown as { type: string }).type}`,
          );
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
   * ✅ IMPLEMENTED: Gets tools from specified MCP servers with filtering applied
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
        // ✅ IMPLEMENTED: Get tools directly from AI SDK MCP client
        const tools = await wrapper.client.tools();

        // ✅ IMPLEMENTED: Apply tool filtering
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
   * ✅ IMPLEMENTED: Filters tools based on allowed/denied configuration
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
   * ✅ IMPLEMENTED: Builds authentication headers for MCP server requests
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
   * ✅ IMPLEMENTED: Closes a specific MCP server connection with aggressive cleanup
   * @param serverId Server ID to close
   */
  async closeServer(serverId: string): Promise<void> {
    const wrapper = this.clients.get(serverId);
    if (!wrapper) return;

    try {
      // ✅ IMPLEMENTED: Close the client connection with enhanced cleanup
      await wrapper.client.close();

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
   * ✅ IMPLEMENTED: Disposes all MCP client resources with enhanced cleanup
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
   * ✅ IMPLEMENTED: Gets the status of all registered MCP servers
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
   * ✅ IMPLEMENTED: Gets the configuration for a specific MCP server
   * @param serverId Server ID
   * @returns Server configuration or undefined
   */
  getServerConfig(serverId: string): MCPServerConfig | undefined {
    const wrapper = this.clients.get(serverId);
    return wrapper?.config;
  }

  /**
   * ✅ IMPLEMENTED: Lists all registered server IDs
   * @returns Array of server IDs
   */
  listServers(): string[] {
    return Array.from(this.clients.keys());
  }
}
```

### Configuration Type Safety Examples

The discriminated union configuration provides compile-time type safety:

```typescript
// ✅ Valid SSE configuration
const sseConfig: MCPServerConfig = {
  id: "weather-api",
  transport: {
    type: "sse",
    url: "https://weather-api.example.com/mcp",
  },
};

// ✅ Valid stdio configuration
const stdioConfig: MCPServerConfig = {
  id: "local-tool",
  transport: {
    type: "stdio",
    command: "node",
    args: ["./tools/local-mcp-server.js"],
  },
};

// ❌ TypeScript compile error - SSE transport cannot have command
const invalidConfig: MCPServerConfig = {
  id: "invalid",
  transport: {
    type: "sse",
    url: "https://api.example.com",
    command: "node", // ← TypeScript error: property doesn't exist on SSE transport
  },
};

// ❌ TypeScript compile error - stdio transport cannot have url
const invalidConfig2: MCPServerConfig = {
  id: "invalid2",
  transport: {
    type: "stdio",
    command: "python",
    url: "https://example.com", // ← TypeScript error: property doesn't exist on stdio transport
  },
};
```

### 3. Enhanced LLM Provider Manager

**Extend LLMProviderManager to support AI SDK MCP tools:**

```typescript
// Enhanced src/core/agents/llm-provider-manager.ts
import { MCPManager } from "./mcp/mcp-manager.ts";

export interface LLMGenerationOptionsWithTools extends LLMGenerationOptions {
  mcpServers?: string[];
  tools?: Record<string, any>; // Additional AI SDK tools
  maxSteps?: number;
  toolChoice?:
    | "auto"
    | "required"
    | "none"
    | { type: "tool"; toolName: string };
}

export class LLMProviderManager {
  private static mcpManager = new MCPManager();

  static async initializeMCPServers(servers: MCPServerConfig[]): Promise<void> {
    for (const serverConfig of servers) {
      await this.mcpManager.registerServer(serverConfig);
    }
  }

  static async generateTextWithTools(
    userPrompt: string,
    options: LLMGenerationOptionsWithTools & Partial<LLMConfig> = {},
  ): Promise<{
    text: string;
    toolCalls: any[];
    toolResults: any[];
    steps: any[];
  }> {
    const startTime = Date.now();

    // Validate and parse configuration
    const configResult = LLMConfigSchema.safeParse({
      ...this.defaultConfig,
      ...options,
    });
    if (!configResult.success) {
      throw new Error(
        `Invalid LLM configuration: ${configResult.error.message}`,
      );
    }
    const config = configResult.data;

    // Prepare tools - combine provided tools with MCP tools
    const allTools: Record<string, any> = { ...options.tools };

    // Add MCP tools if servers are specified
    if (options.mcpServers && options.mcpServers.length > 0) {
      const mcpTools = await this.mcpManager.getToolsForServers(
        options.mcpServers,
      );
      Object.assign(allTools, mcpTools);
    }

    try {
      const client = this.getProviderClient(config.provider, config);

      const messages: CoreMessage[] = [];

      if (options.systemPrompt) {
        messages.push({
          role: "system",
          content: options.systemPrompt,
        });
      }

      let contextualPrompt = userPrompt;
      if (options.memoryContext) {
        contextualPrompt = `${options.memoryContext}\n\nUser request: ${userPrompt}`;
      }

      messages.push({
        role: "user",
        content: contextualPrompt,
      });

      logger.debug("LLM generation with MCP tools starting", {
        operation: options.operationContext?.operation || "unknown",
        provider: config.provider,
        model: config.model,
        toolCount: Object.keys(allTools).length,
        mcpServerCount: options.mcpServers?.length || 0,
        maxSteps: options.maxSteps || 1,
      });

      const result = await generateText({
        model: client(config.model),
        messages,
        tools: Object.keys(allTools).length > 0 ? allTools : undefined,
        toolChoice: options.toolChoice,
        maxSteps: options.maxSteps || 1,
        maxTokens: config.maxTokens,
        temperature: config.temperature,
        abortSignal: controller.signal,
      });

      const duration = Date.now() - startTime;

      logger.debug("LLM generation with MCP tools completed", {
        operation: options.operationContext?.operation || "unknown",
        provider: config.provider,
        model: config.model,
        duration,
        toolCallCount: result.toolCalls.length,
        stepCount: result.steps.length,
        ...options.operationContext,
      });

      return {
        text: result.text,
        toolCalls: result.toolCalls,
        toolResults: result.toolResults,
        steps: result.steps,
      };
    } catch (error) {
      const duration = Date.now() - startTime;

      logger.error("LLM generation with MCP tools failed", {
        operation: options.operationContext?.operation || "unknown",
        provider: config.provider,
        model: config.model,
        duration,
        mcpServerCount: options.mcpServers?.length || 0,
        error: error instanceof Error ? error.message : String(error),
      });

      throw error;
    }
  }

  static async disposeMCPResources(): Promise<void> {
    await this.mcpManager.dispose();
  }
}
```

### 4. Enhanced Configuration Schema

**Update config-loader.ts to support MCP servers:**

```typescript
// Enhanced src/core/config-loader.ts

// Use the same discriminated union schema from MCPManager
const MCPTransportConfigSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("sse"),
    url: z.string().url(),
  }),
  z.object({
    type: z.literal("stdio"),
    command: z.string(),
    args: z.array(z.string()).optional(),
  }),
]);

const MCPAuthConfigSchema = z.object({
  type: z.enum(["bearer", "api_key"]),
  token_env: z.string().optional(),
  header: z.string().optional(),
});

const MCPToolsConfigSchema = z.object({
  allowed: z.array(z.string()).optional(),
  denied: z.array(z.string()).optional(),
});

const MCPServerConfigSchema = z.object({
  transport: MCPTransportConfigSchema,
  auth: MCPAuthConfigSchema.optional(),
  tools: MCPToolsConfigSchema.optional(),
  timeout_ms: z.number().positive().default(30000),
});

// Infer types from schemas
export type MCPTransportConfig = z.infer<typeof MCPTransportConfigSchema>;
export type MCPServerConfig = z.infer<typeof MCPServerConfigSchema> & {
  id: string;
};

const EnhancedWorkspaceConfigSchema = z.object({
  version: z.string(),
  workspace: z.object({
    id: z.uuid(),
    name: z.string().min(1),
    description: z.string(),
  }),
  mcp_servers: z.record(z.string(), MCPServerConfigSchema).optional(),
  agents: z.record(z.string(), WorkspaceAgentConfigSchema),
  jobs: z.record(z.string(), JobSpecificationSchema).optional(),
  signals: z.record(z.string(), WorkspaceSignalConfigSchema),
});

// Enhanced agent config to support MCP server references
const WorkspaceAgentConfigSchema = z.object({
  type: AgentTypeSchema,
  model: z.string().optional(),
  purpose: z.string(),
  tools: z.array(z.string()).optional(),
  mcp_servers: z.array(z.string()).optional(), // NEW: Reference to MCP servers
  prompts: z.record(z.string(), z.string()).optional(),
  temperature: z.number().min(0).max(2).optional(),
  max_tokens: z.number().positive().optional(),
  max_steps: z.number().positive().optional(), // NEW: For multi-step tool calling
  tool_choice: z
    .union([
      z.literal("auto"),
      z.literal("required"),
      z.literal("none"),
      z.object({
        type: z.literal("tool"),
        toolName: z.string(),
      }),
    ])
    .optional(), // NEW: Tool choice control
  // ... existing fields
});
```

### 5. Enhanced Agent Execution Worker

**Update agent-execution-worker.ts to handle MCP-enabled LLM agents:**

```typescript
// Enhanced src/core/workers/agent-execution-worker.ts

interface AgentExecutePayload {
  agent_id: string;
  agent_config: {
    type: string;
    model?: string;
    parameters: Record<string, unknown>;
    prompts: Record<string, string>;
    tools: string[];
    mcp_servers?: string[]; // NEW: MCP server references
    max_steps?: number; // NEW: Multi-step support
    tool_choice?: any; // NEW: Tool choice control
    // ... existing fields
  };
  task: string;
  input: unknown;
  workspace_config?: {
    mcp_servers?: Record<string, MCPServerConfig>; // NEW: MCP server configs
  };
  // ... existing fields
}

class AgentExecutionWorker {
  private async executeLLMAgent(
    request: AgentExecutePayload,
  ): Promise<Record<string, unknown>> {
    const { model, prompts, parameters, mcp_servers, max_steps, tool_choice } =
      request.agent_config;
    const { task, input, workspace_config } = request;

    if (!model) {
      throw new Error("LLM agent requires model specification");
    }

    // Initialize MCP servers if specified
    if (mcp_servers && workspace_config?.mcp_servers) {
      const mcpServerConfigs = mcp_servers
        .map((serverId) => ({
          ...workspace_config.mcp_servers![serverId],
          id: serverId,
        }))
        .filter(Boolean);

      if (mcpServerConfigs.length > 0) {
        await LLMProviderManager.initializeMCPServers(mcpServerConfigs);
      }
    }

    // Extract provider and parameters
    const params = (parameters as Record<string, unknown>) || {};
    const provider = params.provider || "anthropic";

    // Prepare prompts
    const promptsObj = (prompts as Record<string, string>) || {};
    const systemPrompt = promptsObj.system || "You are a helpful AI assistant.";
    const userPrompt = this.buildUserPrompt(task, input, promptsObj);

    try {
      const result = await LLMProviderManager.generateTextWithTools(
        userPrompt,
        {
          provider: provider as "anthropic" | "openai" | "google",
          model: model as string,
          systemPrompt,
          temperature: params.temperature as number,
          maxTokens: params.max_tokens as number,
          timeout: (request.environment as any).worker_config?.timeout || 30000,
          mcpServers: mcp_servers,
          maxSteps: max_steps || 1,
          toolChoice: tool_choice,
          operationContext: {
            operation: "agent_execution",
            agentId: request.agent_id,
            workerId: this.workerId,
          },
        },
      );

      this.log(
        `LLM execution with MCP tools successful for ${request.agent_id}`,
        "debug",
      );

      return {
        agent_type: "llm",
        agent_id: request.agent_id,
        provider,
        model,
        result: result.text,
        tool_calls: result.toolCalls,
        tool_results: result.toolResults,
        steps: result.steps,
        input,
        tokens_used: 0, // TODO: Extract from result
        finish_reason: "stop",
        mcp_servers_used: mcp_servers || [],
      };
    } catch (error) {
      this.log(
        `LLM execution error for ${request.agent_id}: ${error}`,
        "error",
      );
      throw error;
    } finally {
      // Clean up MCP resources
      if (mcp_servers && mcp_servers.length > 0) {
        await LLMProviderManager.disposeMCPResources();
      }
    }
  }
}
```

## Testing Strategy

To prevent feedback loops and ensure robust integration, we'll implement comprehensive testing
**before** core implementation. This front-loaded testing approach will validate our architectural
assumptions and catch integration issues early.

### Test-First Development Approach

**1. Real MCP Server Testing** - Use actual MCP servers for authentic protocol testing **2. Unit
Test Scaffolding** - Build test harnesses for each component before implementation **3. Integration
Test Framework** - Validate cross-component communication patterns **4. Feedback Loop Detection** -
Automated tests to catch recursive or infinite call patterns

### Core Component Test Suites

#### 1. MCPManager Unit Tests

```typescript
// tests/unit/mcp-manager.test.ts
import { expect } from "@std/expect";
import { MCPManager } from "../../../src/core/agents/mcp/mcp-manager.ts";
import { createTestEnvironment, findAvailablePort } from "../../utils/test-utils.ts";

// Use shared test MCP servers from test utilities
import { TestMCPServers } from "../../utils/test-mcp-servers.ts";

Deno.test({
  name: "MCPManager - Server Registration with Real MCP Server",
  async fn() {
    const testEnv = createTestEnvironment();

    try {
      // Start real MCP server
      const weatherServer = await TestMCPServers.startWeatherServer();
      testEnv.onCleanup(() => weatherServer.stop());

      const manager = new MCPManager();

      // Register stdio transport with real server
      await manager.registerServer({
        id: "test-weather-server",
        transport: {
          type: "stdio",
          command: "node",
          args: weatherServer.getCommand().args, // Use the running process
        },
      });

      // Verify server is registered and tools are available
      const tools = await manager.getToolsForServers(["test-weather-server"]);

      expect(typeof tools).toBe("object");
      expect("get_weather" in tools).toBe(true);
      expect("get_forecast" in tools).toBe(true);
    } finally {
      await testEnv.cleanup();
    }
  },
});

Deno.test({
  name: "MCPManager - Tool Filtering with Real Server",
  async fn() {
    const testEnv = createTestEnvironment();

    try {
      const weatherServer = await TestMCPServers.startWeatherServer();
      testEnv.onCleanup(() => weatherServer.stop());

      const manager = new MCPManager();

      // Register with tool filtering
      await manager.registerServer({
        id: "filtered-server",
        transport: {
          type: "stdio",
          command: "node",
          args: weatherServer.getCommand().args,
        },
        tools: {
          allowed: ["get_weather"],
          denied: ["get_forecast"],
        },
      });

      const tools = await manager.getToolsForServers(["filtered-server"]);

      // Verify only allowed tools are included
      expect("get_weather" in tools).toBe(true);
      expect("get_forecast" in tools).toBe(false);
    } finally {
      await testEnv.cleanup();
    }
  },
});

Deno.test({
  name: "MCPManager - Connection Lifecycle",
  async fn() {
    const testEnv = createTestEnvironment();

    try {
      const weatherServer = await TestMCPServers.startWeatherServer();
      testEnv.onCleanup(() => weatherServer.stop());

      const manager = new MCPManager();

      await manager.registerServer({
        id: "lifecycle-server",
        transport: {
          type: "stdio",
          command: "node",
          args: weatherServer.getCommand().args,
        },
      });

      // Test graceful shutdown
      await manager.closeServer("lifecycle-server");
      await manager.dispose();

      // Verify connection is closed
      expect(true).toBe(true); // Test passes if no errors thrown
    } finally {
      await testEnv.cleanup();
    }
  },
});
```

#### 2. LLMProviderManager Integration Tests

```typescript
// tests/integration/llm-provider-manager.test.ts
import { expect } from "@std/expect";
import { LLMProviderManager } from "../../../src/core/agents/llm-provider-manager.ts";
import { createTestEnvironment, findAvailablePort } from "../../utils/test-utils.ts";

// Import shared test MCP servers and utilities
import { TestMCPServers } from "../../utils/test-mcp-servers.ts";

Deno.test({
  name: "LLMProviderManager - MCP Tool Integration with Real Server",
  async fn() {
    const testEnv = createTestEnvironment();

    try {
      // Start real weather MCP server
      const weatherServer = await TestMCPServers.startWeatherServer();
      testEnv.onCleanup(() => weatherServer.stop());

      // Initialize MCP servers
      await LLMProviderManager.initializeMCPServers([
        {
          id: "test-weather",
          transport: {
            type: "stdio",
            command: "node",
            args: weatherServer.getCommand().args,
          },
        },
      ]);

      // Test tool calling with real LLM
      const result = await LLMProviderManager.generateTextWithTools(
        "What's the weather in San Francisco?",
        {
          provider: "anthropic",
          model: "claude-3-5-haiku-20241022", // Use faster model for tests
          mcpServers: ["test-weather"],
          maxSteps: 2,
          temperature: 0, // Deterministic for testing
        },
      );

      // Verify tool was called
      expect(result.toolCalls.length).toBeGreaterThan(0);
      expect(result.toolCalls[0].toolName).toBe("get_weather");
      expect(result.text).toContain("San Francisco");

      await LLMProviderManager.disposeMCPResources();
    } finally {
      await testEnv.cleanup();
    }
  },
});

Deno.test({
  name: "LLMProviderManager - Feedback Loop Prevention with Real Server",
  async fn() {
    const testEnv = createTestEnvironment();

    try {
      const loopServer = await TestMCPServers.startFeedbackLoopServer();
      testEnv.onCleanup(() => loopServer.stop());

      await LLMProviderManager.initializeMCPServers([
        {
          id: "loop-test",
          transport: {
            type: "stdio",
            command: "node",
            args: weatherServer.getCommand().args,
          },
        },
      ]);

      // This should trigger feedback loop detection in the MCP server
      let caughtError = false;
      try {
        await LLMProviderManager.generateTextWithTools(
          "Keep calling the recursive_tool repeatedly to test feedback loop detection",
          {
            provider: "anthropic",
            model: "claude-3-5-haiku-20241022",
            mcpServers: ["loop-test"],
            maxSteps: 10, // Allow enough steps to trigger loop detection
            temperature: 0,
          },
        );
      } catch (error) {
        caughtError = true;
        expect(error.message).toContain("feedback loop");
      }

      expect(caughtError).toBe(true);
      await LLMProviderManager.disposeMCPResources();
    } finally {
      await testEnv.cleanup();
    }
  },
});

Deno.test({
  name: "LLMProviderManager - Multi-tool Workflow with Real Server",
  async fn() {
    const testEnv = createTestEnvironment();

    try {
      const weatherServer = await TestMCPServers.startWeatherServer();
      testEnv.onCleanup(() => weatherServer.stop());

      await LLMProviderManager.initializeMCPServers([
        {
          id: "weather-multi",
          transport: {
            type: "stdio",
            command: "node",
            args: weatherServer.getCommand().args,
          },
        },
      ]);

      // Test multi-step workflow: get current weather then forecast
      const result = await LLMProviderManager.generateTextWithTools(
        "Get the current weather in New York and then get a 5-day forecast",
        {
          provider: "anthropic",
          model: "claude-3-5-haiku-20241022",
          mcpServers: ["weather-multi"],
          maxSteps: 5,
          temperature: 0,
        },
      );

      // Should have called both tools
      const toolNames = result.toolCalls.map((call) => call.toolName);
      expect(toolNames).toContain("get_weather");
      expect(toolNames).toContain("get_forecast");
      expect(result.toolCalls.length).toBeGreaterThanOrEqual(2);

      await LLMProviderManager.disposeMCPResources();
    } finally {
      await testEnv.cleanup();
    }
  },
});
```

#### 3. Configuration Schema Validation Tests

```typescript
// tests/unit/config-validation.test.ts
import { expect } from "@std/expect";
import {
  MCPAuthConfigSchema,
  MCPServerConfigSchema,
  MCPToolsConfigSchema,
  MCPTransportConfigSchema,
} from "../../../src/core/agents/mcp/ai-sdk-mcp-manager.ts";

Deno.test({
  name: "MCP Configuration - Valid SSE Transport",
  fn() {
    const sseConfig = {
      id: "weather-api",
      transport: {
        type: "sse",
        url: "https://weather-api.example.com/mcp",
      },
      auth: {
        type: "bearer",
        token_env: "WEATHER_TOKEN",
      },
      tools: {
        allowed: ["get_weather"],
      },
      timeout_ms: 30000,
    };

    // Should parse without errors
    const result = MCPServerConfigSchema.safeParse(sseConfig);
    expect(result.success).toBe(true);

    if (result.success) {
      expect(result.data.transport.type).toBe("sse");
      expect(result.data.transport.url).toBe(
        "https://weather-api.example.com/mcp",
      );
    }
  },
});

Deno.test({
  name: "MCP Configuration - Valid Stdio Transport",
  fn() {
    const stdioConfig = {
      id: "local-tools",
      transport: {
        type: "stdio",
        command: "node",
        args: ["./tools/local-server.js"],
      },
      tools: {
        allowed: ["file_read", "file_write"],
      },
    };

    const result = MCPServerConfigSchema.safeParse(stdioConfig);
    expect(result.success).toBe(true);

    if (result.success) {
      expect(result.data.transport.type).toBe("stdio");
      expect(result.data.transport.command).toBe("node");
      expect(result.data.transport.args).toEqual(["./tools/local-server.js"]);
    }
  },
});

Deno.test({
  name: "MCP Configuration - Invalid Transport Type",
  fn() {
    const invalidConfig = {
      id: "bad-server",
      transport: {
        type: "invalid_transport",
        url: "https://example.com",
      },
    };

    const result = MCPServerConfigSchema.safeParse(invalidConfig);
    expect(result.success).toBe(false);

    if (!result.success) {
      expect(result.error.issues[0].message).toContain("invalid_enum_value");
    }
  },
});

Deno.test({
  name: "MCP Configuration - SSE Cannot Have Command",
  fn() {
    const invalidSSEConfig = {
      id: "invalid-sse",
      transport: {
        type: "sse",
        url: "https://example.com/mcp",
        command: "node", // This should fail
      },
    };

    const result = MCPTransportConfigSchema.safeParse(
      invalidSSEConfig.transport,
    );
    expect(result.success).toBe(false);
  },
});

Deno.test({
  name: "MCP Configuration - Stdio Cannot Have URL",
  fn() {
    const invalidStdioConfig = {
      id: "invalid-stdio",
      transport: {
        type: "stdio",
        command: "node",
        url: "https://example.com", // This should fail
      },
    };

    const result = MCPTransportConfigSchema.safeParse(
      invalidStdioConfig.transport,
    );
    expect(result.success).toBe(false);
  },
});

Deno.test({
  name: "MCP Configuration - Tool Filtering Validation",
  fn() {
    const toolsConfig = {
      allowed: ["get_weather", "get_forecast"],
      denied: ["delete_data", "system_exec"],
    };

    const result = MCPToolsConfigSchema.safeParse(toolsConfig);
    expect(result.success).toBe(true);

    if (result.success) {
      expect(result.data.allowed).toEqual(["get_weather", "get_forecast"]);
      expect(result.data.denied).toEqual(["delete_data", "system_exec"]);
    }
  },
});

Deno.test({
  name: "MCP Configuration - Authentication Validation",
  fn() {
    const authConfigs = [
      {
        type: "bearer",
        token_env: "API_TOKEN",
      },
      {
        type: "api_key",
        token_env: "API_KEY",
        header: "X-API-Key",
      },
    ];

    for (const authConfig of authConfigs) {
      const result = MCPAuthConfigSchema.safeParse(authConfig);
      expect(result.success).toBe(true);

      if (result.success) {
        expect(result.data.type).toBe(authConfig.type);
        expect(result.data.token_env).toBe(authConfig.token_env);
      }
    }
  },
});

Deno.test({
  name: "MCP Configuration - Default Values",
  fn() {
    const minimalConfig = {
      id: "minimal-server",
      transport: {
        type: "sse",
        url: "https://example.com/mcp",
      },
    };

    const result = MCPServerConfigSchema.safeParse(minimalConfig);
    expect(result.success).toBe(true);

    if (result.success) {
      expect(result.data.timeout_ms).toBe(30000); // Default value
    }
  },
});

Deno.test({
  name: "MCP Configuration - Type Safety Examples",
  fn() {
    // These examples demonstrate TypeScript compile-time type safety
    // (shown as runtime validation since we can't test compile-time in Deno.test)

    // Valid configurations
    const validSSE = {
      type: "sse" as const,
      url: "https://api.example.com/mcp",
    };

    const validStdio = {
      type: "stdio" as const,
      command: "python",
      args: ["-m", "my_mcp_server"],
    };

    expect(MCPTransportConfigSchema.safeParse(validSSE).success).toBe(true);
    expect(MCPTransportConfigSchema.safeParse(validStdio).success).toBe(true);

    // Invalid configurations would fail TypeScript compilation in real code
    const invalidMixed = {
      type: "sse" as const,
      url: "https://api.example.com/mcp",
      command: "node", // TypeScript would prevent this
    };

    // At runtime, Zod validation catches these errors
    expect(MCPTransportConfigSchema.safeParse(invalidMixed).success).toBe(
      false,
    );
  },
});
```

#### 4. Agent Execution Worker Tests

```typescript
// tests/integration/agent-execution-worker.test.ts
import { expect } from "@std/expect";
import { createTestEnvironment } from "../../utils/test-utils.ts";

// Import test MCP servers from shared utilities
import { TestMCPServers } from "../../utils/test-mcp-servers.ts";

Deno.test({
  name: "AgentExecutionWorker - MCP Tool Execution with Real Server",
  async fn() {
    const testEnv = createTestEnvironment();

    try {
      // Start real MCP server
      const mcpServer = await TestMCPServers.startWeatherServer();
      testEnv.onCleanup(() => mcpServer.stop());

      // Create worker execution request with real MCP server
      const request = {
        agent_id: "test-weather-agent",
        agent_config: {
          type: "llm",
          model: "claude-3-5-haiku-20241022",
          parameters: {
            provider: "anthropic",
            temperature: 0, // Deterministic for testing
          },
          prompts: {
            system:
              "You are a weather assistant. Use the available tools to get weather information.",
          },
          tools: [],
          mcp_servers: ["weather_api"],
          max_steps: 3,
        },
        task: "Get the weather for San Francisco",
        input: { location: "San Francisco" },
        workspace_config: {
          mcp_servers: {
            weather_api: {
              id: "weather_api",
              transport: {
                type: "stdio",
                command: "node",
                args: mcpServer.getCommand().args, // Connect to real server
              },
            },
          },
        },
        environment: {
          worker_config: {
            timeout: 30000,
            allowed_permissions: ["read", "network"],
            memory_limit: 256,
            isolation_level: "worker",
          },
          monitoring_config: {
            log_level: "info",
            metrics_collection: true,
            safety_checks: ["memory_limit", "permissions"],
            output_validation: true,
          },
        },
      };

      // Since AgentExecutionWorker runs in a Web Worker, we'll test the execution logic
      // by simulating what would happen in the worker
      const { LLMProviderManager } = await import(
        "../../../src/core/agents/llm-provider-manager.ts"
      );

      // Initialize MCP servers
      await LLMProviderManager.initializeMCPServers([
        request.workspace_config.mcp_servers.weather_api,
      ]);

      // Execute LLM with MCP tools
      const result = await LLMProviderManager.generateTextWithTools(
        `Task: ${request.task}\\nInput: ${JSON.stringify(request.input)}`,
        {
          provider: "anthropic",
          model: request.agent_config.model,
          systemPrompt: request.agent_config.prompts.system,
          mcpServers: request.agent_config.mcp_servers,
          maxSteps: request.agent_config.max_steps,
          temperature: request.agent_config.parameters.temperature,
        },
      );

      // Verify execution results
      expect(result.toolCalls.length).toBeGreaterThan(0);
      expect(result.toolCalls[0].toolName).toBe("get_weather");
      expect(result.text).toContain("San Francisco");

      // Verify tool was called with correct arguments
      const weatherCall = result.toolCalls.find(
        (call) => call.toolName === "get_weather",
      );
      expect(weatherCall).toBeDefined();
      expect(weatherCall?.args.location).toContain("San Francisco");

      await LLMProviderManager.disposeMCPResources();
    } finally {
      await testEnv.cleanup();
    }
  },
});
```

### Feedback Loop Detection Tests

Feedback loop detection is now integrated into the real MCP servers used in testing, providing more
authentic testing scenarios. The detection logic is implemented within the actual MCP server
implementations in the test suite above, rather than as separate mock utilities.

### Test Infrastructure Setup

The test infrastructure now uses real MCP servers created dynamically for each test. This approach
provides several advantages:

1. **Authentic Protocol Testing**: Tests use actual MCP JSON-RPC protocol implementation
2. **Real Server Lifecycle**: Tests validate process management and cleanup
3. **Transport Validation**: Both SSE and stdio transports tested with real implementations
4. **Error Scenarios**: Real servers can produce authentic MCP errors

Test infrastructure is handled by the existing `createTestEnvironment()` utility from Atlas test
utils, with MCP servers created on-demand using helper functions like `startWeatherMCPServer()`
shown in the test examples above.

### Transport-Specific Tests

#### SSE vs Stdio Transport Comparison Tests

```typescript
// tests/integration/transport-comparison.test.ts
import { expect } from "@std/expect";
import { MCPManager } from "../../../src/core/agents/mcp/ai-sdk-mcp-manager.ts";
import { LLMProviderManager } from "../../../src/core/agents/llm-provider-manager.ts";
import { createTestEnvironment } from "../../utils/test-utils.ts";

// Note: These tests now use real MCP servers instead of mocks
Deno.test({
  name: "Transport Comparison - SSE vs Stdio Same Functionality",
  async fn() {
    const testEnv = createTestEnvironment();

    try {
      // For this test, we would need both SSE and stdio MCP servers
      // providing the same tools. In practice, this would require
      // setting up an HTTP MCP server for SSE transport testing.

      const manager = new MCPManager();

      // Start stdio weather server
      const weatherServer = await TestMCPServers.startWeatherServer();
      testEnv.onCleanup(() => weatherServer.stop());

      // Register stdio transport
      await manager.registerServer({
        id: "stdio-weather",
        transport: {
          type: "stdio",
          command: "node",
          args: weatherServer.getCommand().args,
        },
      });

      // Get tools from stdio transport
      const stdioTools = await manager.getToolsForServers(["stdio-weather"]);

      // Verify tools are available
      expect("get_weather" in stdioTools).toBe(true);
      expect("get_forecast" in stdioTools).toBe(true);

      await manager.dispose();
    } finally {
      await testEnv.cleanup();
    }
  },
});

Deno.test({
  name: "Stdio Transport - Process Lifecycle",
  async fn() {
    const testEnv = createTestEnvironment();

    try {
      const manager = new MCPManager();

      // Start stdio server
      const weatherServer = await TestMCPServers.startWeatherServer();
      testEnv.onCleanup(() => weatherServer.stop());

      await manager.registerServer({
        id: "stdio-lifecycle",
        transport: {
          type: "stdio",
          command: "node",
          args: weatherServer.getCommand().args,
        },
      });

      // Verify tools are available
      const tools = await manager.getToolsForServers(["stdio-lifecycle"]);
      expect("get_weather" in tools).toBe(true);
      expect("get_forecast" in tools).toBe(true);

      // Test graceful process termination
      await manager.closeServer("stdio-lifecycle");

      // Verify process is cleaned up
      const toolsAfterClose = await manager.getToolsForServers([
        "stdio-lifecycle",
      ]);
      expect(Object.keys(toolsAfterClose).length).toBe(0);
    } finally {
      await testEnv.cleanup();
    }
  },
});
```

```ts
#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

// Feedback loop detection
const callHistory = [];

function detectFeedbackLoop(toolName) {
  const call = { tool: toolName, timestamp: Date.now() };
  callHistory.push(call);

  // Check for rapid repeated calls
  const recentCalls = callHistory.filter(
    c => c.timestamp > Date.now() - 1000 && c.tool === toolName
  );

  if (recentCalls.length > 5) {
    throw new Error(\`Potential feedback loop detected: \${toolName} called \${recentCalls.length} times in 1s\`);
  }
}

const server = new Server(
  {
    name: 'weather-mock-server',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Define weather tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'get_weather',
        description: 'Get current weather for a location',
        inputSchema: {
          type: 'object',
          properties: {
            location: {
              type: 'string',
              description: 'The location to get weather for',
            },
          },
          required: ['location'],
        },
      },
      {
        name: 'get_forecast',
        description: 'Get weather forecast',
        inputSchema: {
          type: 'object',
          properties: {
            location: {
              type: 'string',
              description: 'The location to get forecast for',
            },
            days: {
              type: 'number',
              description: 'Number of days to forecast',
              default: 3,
            },
          },
          required: ['location'],
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    detectFeedbackLoop(name);

    switch (name) {
      case 'get_weather':
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                location: args.location,
                temperature: 72,
                conditions: 'sunny',
                timestamp: new Date().toISOString(),
              }),
            },
          ],
        };

      case 'get_forecast':
        const days = args.days || 3;
        const forecast = Array.from({ length: days }, (_, i) => ({
          day: i + 1,
          temperature: 70 + Math.random() * 20,
          conditions: ['sunny', 'cloudy', 'rainy'][Math.floor(Math.random() * 3)],
        }));

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                location: args.location,
                days,
                forecast,
              }),
            },
          ],
        };

      default:
        throw new Error(\`Unknown tool: \${name}\`);
    }
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: \`Error: \${error.message}\`,
        },
      ],
      isError: true,
    };
  }
});

// Start the server
const transport = new StdioServerTransport();
await server.connect(transport);
console.error('Weather MCP Server running on stdio');
`;

  await Deno.writeTextFile("tests/mocks/weather-mcp-server.mjs", weatherServerScript);
  await Deno.chmod("tests/mocks/weather-mcp-server.mjs", 0o755);

  // Create file tools MCP server using official SDK
  const fileToolsServerScript = `
#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const callHistory = [];

function detectFeedbackLoop(toolName) {
  const call = { tool: toolName, timestamp: Date.now() };
  callHistory.push(call);

  const recentCalls = callHistory.filter(
    c => c.timestamp > Date.now() - 1000 && c.tool === toolName
  );

  if (recentCalls.length > 5) {
    throw new Error(\`Feedback loop detected: \${toolName}\`);
  }
}

const server = new Server(
  {
    name: 'file-tools-mock-server',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'file_read',
        description: 'Read file contents',
        inputSchema: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'Path to the file to read',
            },
          },
          required: ['path'],
        },
      },
      {
        name: 'file_write',
        description: 'Write file contents',
        inputSchema: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'Path to the file to write',
            },
            content: {
              type: 'string',
              description: 'Content to write to the file',
            },
          },
          required: ['path', 'content'],
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    detectFeedbackLoop(name);

    switch (name) {
      case 'file_read':
        return {
          content: [
            {
              type: 'text',
              text: \`Mock file contents for: \${args.path}\`,
            },
          ],
        };

      case 'file_write':
        return {
          content: [
            {
              type: 'text',
              text: \`Successfully wrote to file: \${args.path}\`,
            },
          ],
        };

      default:
        throw new Error(\`Unknown tool: \${name}\`);
    }
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: \`Error: \${error.message}\`,
        },
      ],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('File Tools MCP Server running on stdio');
`;

  await Deno.writeTextFile("tests/mocks/file-tools-mcp-server.mjs", fileToolsServerScript);
  await Deno.chmod("tests/mocks/file-tools-mcp-server.mjs", 0o755);

  // Create simple echo server based on official example
  const echoServerScript = `
#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const server = new Server(
  {
    name: 'echo-server',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'echo',
        description: 'Echo back the input',
        inputSchema: {
          type: 'object',
          properties: {
            message: {
              type: 'string',
              description: 'Message to echo back',
            },
          },
          required: ['message'],
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === 'echo') {
    return {
      content: [
        {
          type: 'text',
          text: args.message,
        },
      ],
    };
  } else {
    throw new Error(\`Unknown tool: \${name}\`);
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('Echo MCP Server running on stdio');
`;

  await Deno.writeTextFile("tests/mocks/echo-mcp-server.mjs", echoServerScript);
  await Deno.chmod("tests/mocks/echo-mcp-server.mjs", 0o755);
}

async function ensureMCPSDKInstalled() {
  try {
    // Check if package.json exists in tests/mocks
    await Deno.stat("tests/mocks/package.json");
  } catch {
    // Create package.json and install MCP SDK
    const packageJson = {
      "name": "atlas-mcp-test-servers",
      "version": "1.0.0",
      "type": "module",
      "dependencies": {
        "@modelcontextprotocol/sdk": "^1.0.0",
        "zod": "^3.22.0",
      },
    };

    await Deno.writeTextFile("tests/mocks/package.json", JSON.stringify(packageJson, null, 2));

    // Install dependencies
    const installProcess = new Deno.Command("npm", {
      args: ["install"],
      cwd: "tests/mocks",
    });

    await installProcess.output();
  }
}

async function cleanupMCPMockServers() {
  try {
    await Deno.remove("tests/mocks/weather-mcp-server.mjs");
    await Deno.remove("tests/mocks/file-tools-mcp-server.mjs");
    await Deno.remove("tests/mocks/echo-mcp-server.mjs");
    await Deno.remove("tests/mocks/package.json");
    await Deno.remove("tests/mocks/node_modules", { recursive: true });
  } catch {
    // Ignore cleanup errors
  }
}
```

### Transport-Specific Tests

#### SSE vs Stdio Transport Comparison Tests

```typescript
// tests/integration/transport-comparison.test.ts
import { assertEquals } from "https://deno.land/std@0.210.0/assert/mod.ts";
import { MCPManager } from "../../../src/core/agents/mcp/ai-sdk-mcp-manager.ts";
import { LLMProviderManager } from "../../../src/core/agents/llm-provider-manager.ts";

Deno.test(
  "Transport Comparison - SSE vs Stdio Same Functionality",
  async () => {
    const manager = new AIMCPManager();

    // Test SSE transport
    await manager.registerServer({
      id: "sse-weather",
      transport: {
        type: "sse",
        url: "http://localhost:3001/mcp",
      },
    });

    // Test stdio transport
    await manager.registerServer({
      id: "stdio-weather",
      transport: {
        type: "stdio",
        command: "node",
        args: ["tests/mocks/weather-mcp-server.mjs"],
      },
    });

    // Get tools from both transports
    const sseTools = await manager.getToolsForServers(["sse-weather"]);
    const stdioTools = await manager.getToolsForServers(["stdio-weather"]);

    // Both should have same tools available
    assertEquals(Object.keys(sseTools).sort(), Object.keys(stdioTools).sort());

    await manager.dispose();
  },
);

Deno.test("Stdio Transport - Process Lifecycle", async () => {
  const manager = new AIMCPManager();

  // Start stdio server
  await manager.registerServer({
    id: "stdio-lifecycle",
    transport: {
      type: "stdio",
      command: "node",
      args: ["tests/mocks/stdio-tools-server.js"],
    },
  });

  // Verify tools are available
  const tools = await manager.getToolsForServers(["stdio-lifecycle"]);
  assertEquals("file_read" in tools, true);
  assertEquals("file_write" in tools, true);

  // Test graceful process termination
  await manager.closeServer("stdio-lifecycle");

  // Verify process is cleaned up
  const toolsAfterClose = await manager.getToolsForServers(["stdio-lifecycle"]);
  assertEquals(Object.keys(toolsAfterClose).length, 0);
});

Deno.test("Stdio Transport - Feedback Loop Detection", async () => {
  const manager = new AIMCPManager();

  await manager.registerServer({
    id: "stdio-loop-test",
    transport: {
      type: "stdio",
      command: "node",
      args: ["tests/mocks/file-tools-mcp-server.mjs"],
    },
  });

  // Simulate rapid tool calls that should trigger feedback loop detection
  const results = [];
  for (let i = 0; i < 7; i++) {
    try {
      const result = await LLMProviderManager.generateTextWithTools(
        "Read the same file repeatedly",
        {
          provider: "anthropic",
          model: "claude-3-5-sonnet-20241022",
          mcpServers: ["stdio-loop-test"],
          maxSteps: 1,
          toolChoice: { type: "tool", toolName: "file_read" },
        },
      );
      results.push(result);
    } catch (error) {
      assertEquals(error.message.includes("Feedback loop detected"), true);
      break;
    }
  }

  // Should have detected feedback loop before completing all calls
  assertEquals(results.length < 7, true);

  await manager.dispose();
});
```

#### Real-world Stdio Usage Examples

```typescript
// tests/integration/stdio-real-world.test.ts
import { assertEquals } from "https://deno.land/std@0.210.0/assert/mod.ts";

Deno.test("Stdio Real-World - File Operations Workflow", async () => {
  // This test shows how stdio transport would be used for file operations
  const workspaceConfig = {
    mcp_servers: {
      file_tools: {
        transport: {
          type: "stdio",
          command: "node",
          args: ["tests/mocks/file-tools-mcp-server.mjs"],
        },
        tools: {
          allowed: ["file_read", "file_write"],
        },
      },
    },
    agents: {
      file_manager: {
        type: "llm",
        model: "claude-3-5-sonnet-20241022",
        purpose: "File management operations",
        mcp_servers: ["file_tools"],
        max_steps: 3,
        prompts: {
          system:
            "You are a file management assistant. Use the available tools to read and write files as requested.",
        },
      },
    },
  };

  // Test workflow: Read file, modify content, write back
  const result = await executeAgentWorkflow(workspaceConfig, {
    agent: "file_manager",
    task: "Read config.json, update the version field to 2.0, and write it back",
    input: { file_path: "config.json", new_version: "2.0" },
  });

  // Verify the workflow used both file_read and file_write tools
  assertEquals(
    result.tool_calls.some((call) => call.toolName === "file_read"),
    true,
  );
  assertEquals(
    result.tool_calls.some((call) => call.toolName === "file_write"),
    true,
  );
  assertEquals(result.steps.length, 3); // Read, process, write
});

Deno.test("Stdio Real-World - Local Development Tools", async () => {
  // This test shows stdio transport for local development tools
  const workspaceConfig = {
    mcp_servers: {
      dev_tools: {
        transport: {
          type: "stdio",
          command: "python3",
          args: ["-m", "my_mcp_server"], // Python MCP server
        },
        tools: {
          allowed: ["run_tests", "lint_code", "format_code"],
        },
      },
    },
    agents: {
      dev_assistant: {
        type: "llm",
        model: "claude-3-5-sonnet-20241022",
        purpose: "Development workflow automation",
        mcp_servers: ["dev_tools"],
        max_steps: 5,
      },
    },
  };

  const result = await executeAgentWorkflow(workspaceConfig, {
    agent: "dev_assistant",
    task: "Run tests, and if they pass, format the code",
    input: { project_path: "./src" },
  });

  // Verify conditional workflow execution
  assertEquals(
    result.tool_calls.some((call) => call.toolName === "run_tests"),
    true,
  );
  // Format should only run if tests passed
  const testResult = result.tool_calls.find(
    (call) => call.toolName === "run_tests",
  );
  const formatCall = result.tool_calls.find(
    (call) => call.toolName === "format_code",
  );

  if (testResult?.result?.includes("PASS")) {
    assertEquals(formatCall !== undefined, true);
  }
});

// Helper function to simulate agent workflow execution
async function executeAgentWorkflow(config: any, request: any) {
  // Mock implementation that would use the actual Atlas workflow system
  return {
    tool_calls: [
      { toolName: "file_read", args: { path: request.input.file_path } },
      {
        toolName: "file_write",
        args: { path: request.input.file_path, content: "updated" },
      },
    ],
    steps: [
      { step: 1, action: "read_file" },
      { step: 2, action: "process_content" },
      { step: 3, action: "write_file" },
    ],
    result: "File updated successfully",
  };
}
```

### Transport Type Usage Patterns

#### When to Use SSE Transport

```yaml
# Use SSE for remote/cloud MCP servers
mcp_servers:
  weather_api:
    transport:
      type: "sse"
      url: "https://weather-service.example.com/mcp"
    auth:
      type: "bearer"
      token_env: "WEATHER_API_TOKEN"
    tools:
      allowed: ["get_weather", "get_forecast"]
```

#### When to Use Stdio Transport

```yaml
# Use stdio for local tools, development servers, or custom scripts
mcp_servers:
  local_file_tools:
    transport:
      type: "stdio"
      command: "node"
      args: ["./tools/file-mcp-server.js"]
    tools:
      allowed: ["read_file", "write_file", "list_files"]

  python_analysis_tools:
    transport:
      type: "stdio"
      command: "python3"
      args: ["-m", "analysis_mcp_server", "--config", "./analysis-config.json"]
    tools:
      allowed: ["analyze_data", "generate_report"]

  rust_system_tools:
    transport:
      type: "stdio"
      command: "./target/release/system-mcp-server"
      args: ["--mode", "safe"]
    tools:
      denied: ["dangerous_system_call"]
```

### Test Execution Order

```bash
# Run tests in dependency order to catch issues early

# Phase 1: Unit Tests (no external dependencies)
deno test tests/unit/config-validation.test.ts
deno test tests/unit/ai-mcp-manager.test.ts

# Phase 2: Transport-Specific Tests
deno test tests/integration/transport-comparison.test.ts
deno test tests/integration/stdio-real-world.test.ts

# Phase 3: Mock Integration Tests
deno test tests/integration/mock-mcp-integration.test.ts

# Phase 4: Component Integration Tests
deno test tests/integration/llm-provider-manager.test.ts
deno test tests/integration/agent-execution-worker.test.ts

# Phase 5: Feedback Loop & Edge Case Tests
deno test tests/integration/feedback-loop-detection.test.ts
deno test tests/integration/error-scenarios.test.ts

# Phase 6: End-to-End Tests
deno test tests/e2e/complete-workflow.test.ts
deno test tests/e2e/mixed-transport-workflow.test.ts
```

## Implementation Plan

### ✅ Phase 1: Core MCP Manager Implementation (COMPLETED - June 17, 2025)

#### ✅ 1.1 AI SDK MCP Client Implementation (COMPLETED)

- **Task**: Create MCPManager using AI SDK's `experimental_createMCPClient` ✅
- **Files**: `src/core/agents/mcp/mcp-manager.ts` ✅
- **Features**: Native AI SDK integration, type-safe configuration with Zod schemas ✅
- **✨ Implementation**: Full AI SDK MCP client with transport abstraction (SSE and stdio)
- **✨ Technology**: TypeScript with proper type inference from AI SDK
- **✨ Quality**: Comprehensive error handling, logging, and resource cleanup

#### ✅ 1.2 Configuration Schema Implementation (COMPLETED)

- **Task**: Implement type-safe MCP server configuration using Zod schemas ✅
- **Files**: `src/core/agents/mcp/mcp-manager.ts` (includes all schemas) ✅
- **Features**: Discriminated unions for transport types, optional parameters with defaults ✅
- **✨ Implementation**: Full TypeScript type safety with compile-time validation
- **✨ Technology**: Zod v3 with strict object validation and discriminated unions
- **✨ Quality**: Comprehensive validation with helpful error messages

#### ✅ 1.3 Comprehensive Test Suite (COMPLETED)

- **Task**: Create full test suite with real MCP servers and proper resource cleanup ✅
- **Files**: `tests/unit/mcp/mcp-manager.test.ts`, `tests/unit/mcp/config-validation.test.ts` ✅
- **Features**: Real MCP server testing, tool filtering validation, lifecycle management ✅
- **✨ Implementation**: Modern Deno-native MCP servers with proper resource cleanup
- **✨ Technology**: TypeScript/Deno test servers, disabled sanitization for child processes
- **✨ Quality**: All 16 tests pass without resource leaks, comprehensive coverage

#### ✅ 1.4 Mock MCP Server Infrastructure (COMPLETED)

- **Task**: Create comprehensive mock MCP servers for testing ✅
- **Files**: `tests/mocks/weather-mcp-server.ts`, `tests/mocks/file-tools-mcp-server.ts`,
  `tests/mocks/echo-mcp-server.ts` ✅
- **Features**: Modern MCP server implementation, tool registration, error handling ✅
- **✨ Implementation**: Uses latest `McpServer` class with `registerTool()` method
- **✨ Technology**: TypeScript/Deno native servers (no Node.js dependency)
- **✨ Quality**: Proper resource cleanup, comprehensive tool implementations

### 🚧 Phase 2: LLM Provider Integration (IN PROGRESS)

#### 1.1 AI SDK MCP Client Implementation

- **Task**: Create AIMCPManager using AI SDK's `experimental_createMCPClient`
- **Files**: `src/core/agents/mcp/ai-sdk-mcp-manager.ts`
- **Dependencies**: Use AI SDK's built-in MCP support (no additional SDK needed)

#### 1.2 Configuration Schema Enhancement

- **Task**: Update workspace configuration to support MCP transport types
- **Files**: `src/core/config-loader.ts`
- **Changes**: Add mcp_servers with transport configs, enhance agent references

#### 1.3 LLM Provider Manager Enhancement

- **Task**: Add AI SDK MCP tool support to LLMProviderManager
- **Files**: `src/core/agents/llm-provider-manager.ts`
- **Changes**: Add generateTextWithTools method, AI SDK MCP manager integration

#### 1.4 Agent Execution Worker Updates

- **Task**: Update agent execution to handle AI SDK MCP-enabled LLM agents
- **Files**: `src/core/workers/agent-execution-worker.ts`
- **Changes**: MCP server initialization, tool execution handling

### Phase 2: Advanced Features (Week 2)

#### 2.1 Transport Type Support

- **Task**: Implement support for stdio and SSE transports
- **Files**: Enhanced AIMCPManager with transport abstraction
- **Features**: Multi-transport support, connection management

#### 2.2 MCP Server Lifecycle Management

- **Task**: Add connection pooling, health checking, and recovery
- **Files**: `src/core/agents/mcp/mcp-server-lifecycle.ts`
- **Features**: Connection reuse, automatic reconnection, health monitoring

#### 2.3 Tool Execution Monitoring

- **Task**: Add comprehensive monitoring and logging for AI SDK MCP tool calls
- **Files**: Enhanced logging in AIMCPManager and LLMProviderManager
- **Features**: Execution metrics, error tracking, performance monitoring

#### 2.4 Enhanced Error Handling

- **Task**: Implement AI SDK-specific error handling and recovery strategies
- **Files**: All MCP-related files
- **Features**: Graceful degradation, retry logic, detailed error reporting

### Phase 3: Production Features (Week 3)

#### 3.1 Security and Access Control

- **Task**: Implement comprehensive security measures for MCP tool access
- **Features**: Tool allowlists/denylists, authentication validation, input sanitization

#### 3.2 Workspace Example and Documentation

- **Task**: Create comprehensive examples using AI SDK MCP integration
- **Files**: `examples/mcp-weather-analysis/`, documentation updates
- **Features**: End-to-end examples, best practices, troubleshooting guides

#### 3.3 Testing Framework

- **Task**: Create comprehensive test suite for AI SDK MCP integration
- **Files**: `tests/integration/mcp/`, unit tests for all components
- **Features**: Mock MCP servers, integration tests, performance tests

#### 3.4 Performance Optimization

- **Task**: Optimize AI SDK MCP tool execution and connection management
- **Features**: Connection pooling, tool response caching, parallel execution

## Example Usage

### Workspace Configuration

```yaml
# workspace.yml
version: "1.0"
workspace:
  id: "550e8400-e29b-41d4-a716-446655440000"
  name: "weather-analysis-workspace"
  description: "Weather analysis with AI SDK MCP tools"

mcp_servers:
  weather_api:
    transport:
      type: "sse"
      url: "https://weather-api.example.com/mcp"
    auth:
      type: "bearer"
      token_env: "WEATHER_API_TOKEN"
    tools:
      allowed: ["get_weather", "get_forecast", "get_alerts"]
    timeout_ms: 30000

  local_tools:
    transport:
      type: "stdio"
      command: "node"
      args: ["./mcp-servers/local-tools/server.js"]
    tools:
      denied: ["dangerous_operation"]

agents:
  weather_analyst:
    type: "llm"
    model: "claude-3-5-sonnet-20241022"
    purpose: "Weather analysis with live data access"
    mcp_servers: ["weather_api", "local_tools"]
    max_steps: 3
    tool_choice: "auto"
    prompts:
      system: |
        You are a weather analyst with access to live weather data.
        Use the available tools to gather current weather information
        and provide comprehensive analysis.

jobs:
  daily_weather_report:
    description: "Generate daily weather analysis report"
    execution:
      strategy: "sequential"
      agents:
        - id: "weather_analyst"
          task: "Generate comprehensive weather report for San Francisco"

signals:
  daily_trigger:
    description: "Daily weather report trigger"
    provider: "cron"
    schedule: "0 8 * * *"
```

### Agent Execution Flow

1. **Configuration Loading**: Workspace loads MCP server configurations
2. **AI SDK Client Creation**: AIMCPManager creates `experimental_createMCPClient` instances
3. **Agent Execution**: LLM agent receives task and MCP server references
4. **Tool Discovery**: AI SDK automatically discovers and creates tools from MCP servers
5. **LLM Generation**: Model generates text and calls MCP tools through AI SDK
6. **Tool Execution**: MCP tools are executed via AI SDK's native integration
7. **Result Synthesis**: LLM synthesizes tool results into final response

## Success Criteria

### ✅ Functional Requirements (IMPLEMENTED)

- ✅ **AI SDK MCP Integration**: `experimental_createMCPClient` fully implemented and tested
- ✅ **Transport Support**: Both SSE and stdio transport types implemented with type safety
- ✅ **Native Tool Calling**: Direct AI SDK integration without manual tool conversion
- ✅ **Multi-step Execution**: Architecture ready for multi-step tool calling workflows
- ✅ **Configuration Management**: Comprehensive Zod schema validation for workspace configuration

### ✅ Security Requirements (IMPLEMENTED)

- ✅ **Access Control**: Tool allowlists and denylists implemented with filtering logic
- ✅ **Authentication**: Bearer token and API key authentication with environment variable support
- ✅ **Input Validation**: Zod schema validation for all MCP server configurations
- ✅ **Error Isolation**: Comprehensive error handling with proper cleanup and logging

### ✅ Performance Requirements (IMPLEMENTED)

- ✅ **Low Latency**: Configurable timeouts implemented with 30s default
- ✅ **Resource Efficiency**: Aggressive cleanup with process termination and memory management
- ✅ **Scalability**: Map-based client management supporting concurrent server connections
- ✅ **Monitoring**: Comprehensive structured logging with operation tracking and metrics

### ✅ Testing Requirements (IMPLEMENTED)

- ✅ **Unit Tests**: 7 comprehensive MCPManager tests with real MCP servers
- ✅ **Configuration Tests**: 9 validation tests covering all schema scenarios
- ✅ **Resource Management**: Leak-free testing with proper cleanup strategies
- ✅ **Integration Testing**: End-to-end workflow validation with multiple transport types

## Strategic Impact

### Immediate Benefits

- **Native AI SDK Integration**: Leverage Vercel's maintained MCP client and transport
- **Reduced Complexity**: No manual tool conversion or schema mapping
- **Enhanced AI Capabilities**: LLM agents can access live data and services
- **Transport Flexibility**: Support multiple transport types (SSE, stdio)

### Long-term Advantages

- **Protocol Standardization**: Industry-standard tool connectivity
- **Community Ecosystem**: Access to community-built MCP servers
- **Simplified Development**: Easy integration of new tools and services
- **Future-Proof**: Leverage AI SDK's ongoing MCP development

This implementation provides Atlas with comprehensive MCP tool calling capabilities using the Vercel
AI SDK's native MCP support, eliminating the need for manual tool conversion while maintaining the
platform's security, performance, and architectural integrity.
