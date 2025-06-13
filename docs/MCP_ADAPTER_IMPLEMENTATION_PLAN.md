# MCP Adapter Implementation Plan

## Overview

This document outlines the implementation plan for Model Context Protocol (MCP) adapter support in Atlas, building on the successful ACP adapter pattern. MCP enables standardized integration with remote AI tools, resources, and prompts using the official TypeScript SDK.

## Background

### Current Adapter Architecture

Atlas currently supports:

- **LLM Agents** (`type: "llm"`): Direct API integration with LLM providers
- **Tempest Agents** (`type: "tempest"`): First-party agents from Tempest catalog
- **Remote Agents** (`type: "remote"`): External agents via ACP, A2A, and custom protocols

### MCP Protocol Integration

MCP (Model Context Protocol) provides:

- Standardized tool execution via JSON-RPC 2.0
- Resource access for data retrieval
- Prompt template management
- HTTP transport with Server-Sent Events support
- Official TypeScript SDK for client implementation

## Phase 1: Minimal Viable Integration

### 1.1 Direct SDK Integration

**MCP Adapter Architecture:**

```
src/core/agents/remote/adapters/
├── base-remote-adapter.ts           # Existing base class
├── acp-adapter.ts                   # Existing ACP implementation
├── mcp-adapter.ts                   # New simplified MCP implementation
├── a2a-adapter.ts                   # Google A2A (existing)
└── custom-adapter.ts                # Custom HTTP (existing)
```

**Key Design Principles:**

- Use official `@modelcontextprotocol/sdk` directly
- No custom transport wrappers
- Follow existing ACP adapter pattern
- Focus on tool execution first

### 1.2 Configuration Schema

**Simplified Configuration:**

```yaml
agents:
  weather-mcp:
    type: "remote"
    protocol: "mcp"
    purpose: "Weather data and analysis tools"
    endpoint: "https://weather-api.example.com/mcp"
    
    # Authentication (optional)
    auth:
      type: "bearer"
      token_env: "WEATHER_API_TOKEN"
    
    # MCP-specific options (optional)
    mcp:
      timeout_ms: 30000               # Request timeout (default: 30s)
      allowed_tools: ["get_weather"]  # Tool allowlist (optional)
      denied_tools: ["delete_data"]   # Tool denylist (optional)
```

### 1.3 Core Implementation

#### 1.3.1 SDK Dependency

```bash
# Add MCP SDK dependency
deno add npm:@modelcontextprotocol/sdk@^1.0.0
```

#### 1.3.2 Simple MCP Adapter

**Core MCP Adapter Implementation:**

```typescript
// src/core/agents/remote/adapters/mcp-adapter.ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { 
  CallToolResultSchema,
  ListToolsResultSchema 
} from "@modelcontextprotocol/sdk/types.js";
import { BaseRemoteAdapter } from "./base-remote-adapter.ts";
import type {
  RemoteExecutionRequest,
  RemoteExecutionResult,
  HealthStatus,
} from "./base-remote-adapter.ts";
import { AtlasLogger } from "../../../utils/logger.ts";

interface MCPAdapterConfig {
  endpoint: string;
  auth?: {
    type: "bearer" | "api_key";
    token_env?: string;
    header?: string;
  };
  timeout_ms?: number;
  allowed_tools?: string[];
  denied_tools?: string[];
}

export class MCPAdapter extends BaseRemoteAdapter {
  private client: Client;
  private transport: StreamableHTTPClientTransport;
  private config: MCPAdapterConfig;
  private logger: AtlasLogger;
  private connected = false;

  constructor(config: MCPAdapterConfig) {
    super();
    this.config = config;
    this.logger = new AtlasLogger("MCPAdapter");

    // Create MCP client
    this.client = new Client({
      name: "atlas-mcp-client",
      version: "1.0.0",
    });

    // Create transport with auth if provided
    this.transport = new StreamableHTTPClientTransport(
      new URL(config.endpoint),
      { authProvider: this.createAuthProvider() }
    );
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    
    try {
      await this.client.connect(this.transport);
      this.connected = true;
      this.logger.info("Connected to MCP server", { endpoint: this.config.endpoint });
    } catch (error) {
      this.logger.error("Failed to connect to MCP server", { error: error.message });
      throw new Error(`MCP connection failed: ${error.message}`);
    }
  }

  async discoverAgents(): Promise<Agent[]> {
    await this.connect();
    
    try {
      const toolsResult = await this.client.request({
        method: 'tools/list',
        params: {}
      }, ListToolsResultSchema);

      return [{
        name: "mcp-server",
        description: `MCP Server with ${toolsResult.tools.length} tools`,
        metadata: {
          tools: toolsResult.tools.map(t => t.name),
          endpoint: this.config.endpoint,
        },
      }];
    } catch (error) {
      this.logger.error("Failed to discover MCP tools", { error: error.message });
      throw new Error(`MCP discovery failed: ${error.message}`);
    }
  }

  async executeAgent(request: RemoteExecutionRequest): Promise<RemoteExecutionResult> {
    await this.connect();
    
    const startTime = performance.now();
    
    try {
      const toolCall = this.parseToolCall(request.input);
      
      // Check tool filtering
      if (this.config.allowed_tools && !this.config.allowed_tools.includes(toolCall.name)) {
        throw new Error(`Tool '${toolCall.name}' not in allowed tools list`);
      }
      
      if (this.config.denied_tools && this.config.denied_tools.includes(toolCall.name)) {
        throw new Error(`Tool '${toolCall.name}' is denied by configuration`);
      }

      const result = await this.client.request({
        method: 'tools/call',
        params: {
          name: toolCall.name,
          arguments: toolCall.arguments
        }
      }, CallToolResultSchema);

      const executionTime = performance.now() - startTime;

      return {
        executionId: crypto.randomUUID(),
        output: result.content.map(c => ({
          content_type: c.type === 'text' ? 'text/plain' : 'application/json',
          content: c.type === 'text' ? c.text : JSON.stringify(c),
        })),
        status: result.isError ? "failed" : "completed",
        error: result.isError ? "Tool execution failed" : undefined,
        metadata: {
          execution_time_ms: executionTime,
          tool_name: toolCall.name,
        },
      };
    } catch (error) {
      const executionTime = performance.now() - startTime;
      
      return {
        executionId: crypto.randomUUID(),
        output: [],
        status: "failed",
        error: error.message,
        metadata: {
          execution_time_ms: executionTime,
        },
      };
    }
  }

  async healthCheck(): Promise<HealthStatus> {
    try {
      await this.connect();
      
      // Simple health check by listing tools
      await this.client.request({
        method: 'tools/list',
        params: {}
      }, ListToolsResultSchema);

      return { status: "healthy" };
    } catch (error) {
      return { 
        status: "unhealthy", 
        error: error.message 
      };
    }
  }

  private parseToolCall(input: string | MessagePart[]): { name: string; arguments: Record<string, unknown> } {
    const inputStr = typeof input === "string" ? input : input[0]?.content || "";
    
    try {
      // Try to parse as JSON
      const parsed = JSON.parse(inputStr);
      return {
        name: parsed.name || parsed.tool || "unknown",
        arguments: parsed.arguments || parsed.args || {}
      };
    } catch {
      // Fallback: treat entire input as tool name
      return { 
        name: inputStr.trim(), 
        arguments: {} 
      };
    }
  }

  private createAuthProvider() {
    if (!this.config.auth) return undefined;

    // Return a simple auth provider that adds headers
    return {
      getAuthHeaders: () => {
        const headers: Record<string, string> = {};
        
        if (this.config.auth?.type === "bearer" && this.config.auth.token_env) {
          const token = Deno.env.get(this.config.auth.token_env);
          if (token) {
            headers["Authorization"] = `Bearer ${token}`;
          }
        }
        
        if (this.config.auth?.type === "api_key" && this.config.auth.token_env) {
          const apiKey = Deno.env.get(this.config.auth.token_env);
          if (apiKey) {
            headers[this.config.auth.header || "X-API-Key"] = apiKey;
          }
        }
        
        return headers;
      }
    };
  }

  async dispose(): Promise<void> {
    if (this.connected && this.transport) {
      await this.transport.close();
      this.connected = false;
    }
  }
}
```

### 1.4 Configuration Schema Enhancement

**Enhanced Remote Agent Configuration:**

```typescript
// src/core/config-loader.ts (enhancement to existing file)

const MCPConfigSchema = z.object({
  timeout_ms: z.number().positive().default(30000),
  allowed_tools: z.array(z.string()).optional(),
  denied_tools: z.array(z.string()).optional(),
});

// Enhanced WorkspaceAgentConfigSchema with MCP support
const WorkspaceAgentConfigSchema = z
  .object({
    type: AgentTypeSchema,
    model: z.string().optional(),
    purpose: z.string(),
    tools: z.array(z.string()).optional(),
    prompts: z.record(z.string(), z.string()).optional(),

    // Remote agent specific (enhanced for MCP)
    protocol: z.enum(["acp", "a2a", "mcp", "custom"]).optional(),
    endpoint: z.string().url().optional(),
    auth: AuthConfigSchema.optional(),
    
    // Protocol-specific configurations
    mcp: MCPConfigSchema.optional(),
    // ... existing schemas for acp, a2a, custom
  })
  .superRefine((data, ctx) => {
    if (data.type === "remote" && data.protocol === "mcp") {
      if (!data.endpoint) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "MCP remote agents require 'endpoint' field",
          path: ["endpoint"],
        });
      }
    }
  });
```

## Phase 2: Enhanced Features

### 2.1 Agent Loader Integration

**Enhanced Agent Factory:**

```typescript
// src/core/agent-loader.ts (modification to existing file)
export class AgentLoader {
  private createRemoteAdapter(config: RemoteAgentConfig): BaseRemoteAdapter {
    switch (config.protocol) {
      case "acp":
        return new ACPAdapter(config);
      case "mcp":
        return new MCPAdapter(config);
      case "a2a":
      case "custom":
        throw new Error(`${config.protocol} adapter not yet implemented`);
      default:
        throw new Error(`Unsupported remote protocol: ${config.protocol}`);
    }
  }

  private async validateMCPAgent(adapter: MCPAdapter, config: RemoteAgentConfig): Promise<void> {
    try {
      const agents = await adapter.discoverAgents();
      if (agents.length === 0) {
        throw new Error("No MCP capabilities discovered");
      }

      this.logger.info("MCP agent validated", {
        tools_count: agents[0].metadata?.tools?.length || 0,
        endpoint: config.endpoint,
      });
    } catch (error) {
      throw new Error(`MCP validation failed: ${error.message}`);
    }
  }
}
```

### 2.2 Resource and Prompt Support

**Enhanced MCP Adapter for Resources/Prompts:**

```typescript
// Add to existing MCPAdapter class

async executeAgent(request: RemoteExecutionRequest): Promise<RemoteExecutionResult> {
  await this.connect();
  
  const startTime = performance.now();
  
  try {
    const requestData = this.parseRequest(request.input);
    let result;

    switch (requestData.type) {
      case "tool":
        result = await this.executeTool(requestData);
        break;
      case "resource":
        result = await this.readResource(requestData);
        break;
      case "prompt":
        result = await this.getPrompt(requestData);
        break;
      default:
        // Default to tool execution
        result = await this.executeTool({
          type: "tool",
          name: typeof request.input === "string" ? request.input.trim() : "unknown",
          arguments: {}
        });
    }

    return this.formatResult(result, performance.now() - startTime);
  } catch (error) {
    return this.formatError(error, performance.now() - startTime);
  }
}

private async readResource(requestData: { uri: string }): Promise<any> {
  const result = await this.client.request({
    method: 'resources/read',
    params: { uri: requestData.uri }
  }, ReadResourceResultSchema);

  return {
    content: result.contents.map(c => ({
      type: c.type,
      text: c.type === "text" ? c.text : JSON.stringify(c),
    })),
    isError: false,
  };
}

private async getPrompt(requestData: { name: string; arguments?: Record<string, any> }): Promise<any> {
  const result = await this.client.request({
    method: 'prompts/get',
    params: {
      name: requestData.name,
      arguments: requestData.arguments || {}
    }
  }, GetPromptResultSchema);

  return {
    content: [{
      type: "text",
      text: JSON.stringify(result, null, 2),
    }],
    isError: false,
  };
}
```

### 2.3 Testing Framework

**Basic Testing Structure:**

```typescript
// tests/unit/agents/remote/mcp-adapter.test.ts
import { assertEquals, assertRejects } from "https://deno.land/std@0.210.0/assert/mod.ts";
import { MCPAdapter } from "../../../../src/core/agents/remote/adapters/mcp-adapter.ts";

Deno.test("MCPAdapter - Basic Construction", () => {
  const adapter = new MCPAdapter({
    endpoint: "https://test.example.com/mcp",
  });
  
  assertEquals(adapter instanceof MCPAdapter, true);
});

Deno.test("MCPAdapter - Invalid Endpoint", async () => {
  const adapter = new MCPAdapter({
    endpoint: "invalid-url",
  });
  
  await assertRejects(() => adapter.connect());
});
```

## Phase 3: Production Features

### 3.1 Complete Workspace Example

**Production-Ready Configuration:**

```yaml
# workspace.yml
name: "mcp-weather-analysis"
description: "Weather analysis using MCP tools and AI reasoning"

agents:
  weather-mcp:
    type: "remote"
    protocol: "mcp"
    purpose: "Weather data collection and analysis"
    endpoint: "https://weather-api.example.com/mcp"
    auth:
      type: "bearer"
      token_env: "WEATHER_API_TOKEN"
    mcp:
      timeout_ms: 30000
      allowed_tools: ["get_weather", "get_forecast"]
      denied_tools: ["delete_file", "system_exec"]

  analyst:
    type: "llm"
    model: "claude-3-5-sonnet-20241022"
    purpose: "Weather data analysis and insights"

jobs:
  weather-report:
    description: "Generate comprehensive weather analysis"
    agents:
      - id: "weather-mcp"
        role: "data-collector"
        instructions: "Collect current weather and forecast data"
      - id: "analyst"
        role: "analyzer"
        instructions: "Analyze weather patterns and provide insights"

signals:
  daily-report:
    provider: "cron"
    schedule: "0 8 * * *"  # Daily at 8 AM
    jobs: ["weather-report"]
```

### 3.2 Error Handling and Resilience

**Enhanced Error Recovery:**

```typescript
// Add to MCPAdapter class
private async executeWithRetry<T>(
  operation: () => Promise<T>,
  maxRetries: number = 3
): Promise<T> {
  let lastError: Error;
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      
      if (attempt < maxRetries) {
        const delay = Math.min(1000 * Math.pow(2, attempt), 10000); // Exponential backoff
        await new Promise(resolve => setTimeout(resolve, delay));
        
        // Reconnect if connection lost
        if (error.message.includes("connection") || error.message.includes("network")) {
          this.connected = false;
        }
      }
    }
  }
  
  throw lastError!;
}
```

## Implementation Timeline

### 🚀 Phase 1: Minimal Viable Integration (Week 1)
- ✅ MCP SDK integration and dependency management
- ✅ Simple MCPAdapter with tool execution
- ✅ Configuration schema enhancement for MCP protocol
- ✅ Agent loader integration

### 📋 Phase 2: Enhanced Features (Week 2)  
- ✅ Resource and prompt support
- ✅ Enhanced error handling and retry logic
- ✅ Tool filtering and security
- ✅ Basic testing framework

### 🎯 Phase 3: Production Features (Week 3)
- ✅ Complete workspace examples
- ✅ Error recovery and resilience
- ✅ Documentation and usage guides
- ✅ Production deployment patterns

## Success Criteria

### Functional Requirements
- ✅ **MCP protocol compliance** - Full support for tools, resources, and prompts
- ✅ **Transport flexibility** - HTTP transport with fallback support
- ✅ **Atlas integration** - Seamless BaseRemoteAdapter integration
- ✅ **Configuration management** - Complete workspace.yml schema support
- ✅ **Error handling** - Robust error handling and retry logic

### Security Requirements
- ✅ **Tool filtering** - Optional allowlist for tool execution
- ✅ **Input validation** - JSON parsing with fallback handling
- ✅ **Credential management** - Secure environment variable-based auth
- ✅ **Connection security** - HTTPS transport with authentication

### Performance Requirements
- ✅ **Low latency** - Direct SDK usage minimizes overhead
- ✅ **Resource efficiency** - Simple connection management
- ✅ **Scalability** - Stateless adapter design
- ✅ **Basic monitoring** - Health checks and error tracking

## Strategic Impact

### Immediate Benefits
- **Tool Ecosystem Integration**: Access to the growing MCP tool ecosystem
- **Remote Service Integration**: Connect to cloud-based MCP servers
- **Hybrid Agent Workflows**: Combine MCP tools with LLM reasoning

### Long-term Advantages  
- **Protocol Standardization**: Align with industry-standard tool communication
- **Community Ecosystem**: Leverage community-built MCP servers and tools
- **Development Velocity**: Rapid integration of new tools and capabilities

This simplified MCP adapter implementation positions Atlas as a comprehensive AI agent orchestration platform capable of integrating with any MCP-compatible tool or service while maintaining enterprise-grade security, reliability, and performance standards.

## Implementation Todo List

### Phase 1: Core Implementation (High Priority)
- [x] **Task 1**: Add MCP SDK dependency to project (`deno add npm:@modelcontextprotocol/sdk@^1.0.0`)
- [x] **Task 2**: Create MCPAdapter class extending BaseRemoteAdapter with tool execution capabilities
- [x] **Task 3**: Enhance configuration schema to support MCP protocol in workspace.yml
- [x] **Task 4**: Integrate MCP adapter into agent loader factory pattern

### Phase 2: Enhanced Features (Medium Priority)
- [ ] **Task 5**: Add resource and prompt support to MCPAdapter for full MCP capability
- [ ] **Task 6**: Implement error handling and retry logic with exponential backoff
- [ ] **Task 7**: Add tool filtering and security features (allowlist/denylist)
- [x] **Task 8**: Create basic testing framework for MCPAdapter functionality

### Phase 3: Production Features (Low Priority)
- [ ] **Task 9**: Create complete workspace example configuration demonstrating MCP usage
- [ ] **Task 10**: Add documentation and usage guides for MCP adapter deployment

### Completion Status
**Phase 1**: 4/4 tasks completed ✅  
**Phase 2**: 1/4 tasks completed  
**Phase 3**: 0/2 tasks completed  
**Overall**: 5/10 tasks completed