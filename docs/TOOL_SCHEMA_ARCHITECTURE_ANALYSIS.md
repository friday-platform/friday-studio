# Tool Schema Architecture Analysis

## Problem Statement

The Atlas codebase has significant issues with tool schema handling in the LLM Provider, resulting
in:

- Conditional wrapping logic in `prepareTools()` with special cases
- Inconsistent tool formats across different sources
- Runtime checks for AI SDK internal symbols
- Maintenance burden and error-prone code

## Root Cause Analysis

### 1. **Multiple Tool Definition Sources**

Tools are defined in three different places with different formats:

#### a) Daemon Capabilities (src/core/daemon-capabilities.ts)

```typescript
{
  id: string,
  inputSchema: z.ZodSchema<TInput>,  // Single Zod schema object
  implementation: (context, input) => Promise<TOutput>
}
```

#### b) Workspace Capabilities

Similar to daemon capabilities but for workspace-specific operations

#### c) MCP Server Tools (packages/mcp-server/src/tools/)

```typescript
// Uses ZodRawShape type from Zod
server.registerTool<ZodRawShape, ZodRawShape>(name, {
  description: string,
  inputSchema: {
    // Zod schemas directly as property values (ZodRawShape)
    workspaceId: z.string().describe("Workspace ID"),
    force: z.boolean().default(false).describe("Force deletion"),
  },
}, implementation);
```

**Key insight:** The MCP SDK already uses `ZodRawShape` for `inputSchema`, which is:

```typescript
export type ZodRawShape = {
  [k: string]: ZodTypeAny;
};
```

### 2. **AI SDK Requirements**

The Vercel AI SDK requires tools to have:

- Parameters wrapped with `jsonSchema()` or `zodSchema()`
- Internal symbols: `Symbol.for("vercel.ai.schema")` or `Symbol.for("vercel.ai.validator")`
- Specific structure: `{ description, parameters, execute }`

### 3. **Current Conversion Flow**

```
Daemon/Workspace Capability → getDaemonCapabilityTools() → Zod to JSON Schema → prepareTools() → jsonSchema() wrapper
```

This multi-step conversion is where problems arise:

1. `getDaemonCapabilityTools()` converts Zod schemas to JSON Schema manually
2. `prepareTools()` checks if tools need `jsonSchema()` wrapper
3. Special cases like `workspace_draft_update` require simplified schemas
4. **MCP tools already use clean pattern** but we don't leverage it elsewhere

## Why This Architecture Fails

### 1. **Late-Stage Transformation**

Tools are transformed at the last moment before LLM calls, making it difficult to:

- Debug schema issues
- Maintain consistency
- Test tool definitions

### 2. **Loss of Type Safety**

The manual Zod → JSON Schema conversion in `zodSchemaToJsonSchema()` is incomplete and loses type
information

### 3. **Conditional Logic Proliferation**

The `prepareTools()` function has to handle:

- Tools that already have AI SDK symbols
- Tools that need wrapping
- Special cases with simplified schemas
- MCP tools vs capability tools

### 4. **Schema Mutation Concerns**

Deep copying schemas (`JSON.parse(JSON.stringify(params))`) suggests mutation issues

## Proposed Solution

### Key Insight: AI SDK's Tool Type IS the Universal Format

After careful analysis, the AI SDK's `Tool` type already serves as the perfect universal format.
Creating another abstraction (`UniversalToolDefinition`) would only add unnecessary complexity.
Instead, we should:

1. **Use AI SDK's `Tool` type directly** as our universal tool format
2. **Adopt the MCP pattern** for clean parameter definitions
3. **Make capabilities return `Tool` objects** directly

The MCP server tools already demonstrate the correct pattern:

```typescript
// MCP pattern - clean, explicit, type-safe
server.registerTool("delete_workspace", {
  description: "Delete a workspace",
  inputSchema: {
    workspaceId: z.string().describe("Workspace ID"),
    force: z.boolean().default(false).describe("Force deletion"),
    config: z.record(z.string(), z.unknown()).optional().describe("Optional config"),
  },
}, implementation);
```

### 1. **Standardize Capabilities to Return AI SDK Tools**

Update capability interfaces to directly produce AI SDK Tools:

```typescript
// packages/core/src/daemon-capabilities.ts
import { type Tool } from "ai";
import { z } from "zod/v4";

export interface DaemonCapability {
  id: string;
  name: string;
  description: string;
  category: "streaming" | "system" | "management";
  // Direct AI SDK Tool factory method
  toTool(context: DaemonExecutionContext): Tool;
}

// Example daemon capability using MCP pattern
const streamReplyCapability: DaemonCapability = {
  id: "stream_reply",
  name: "Stream Reply",
  description: "Send a streaming reply to a stream via SSE",
  category: "streaming",
  toTool(context: DaemonExecutionContext): Tool {
    return {
      description: this.description,
      parameters: z.object({
        stream_id: z.string().min(1).describe("Stream ID for the reply"),
        message: z.string().min(1).describe("Message content to stream"),
        metadata: z.record(z.string(), z.unknown()).optional().describe("Optional metadata"),
        conversationId: z.string().optional().describe("Optional conversation ID"),
      }),
      execute: async (args) => {
        // Validation already handled by AI SDK
        const { stream_id, message, metadata, conversationId } = args;

        // Execute with context closure
        await context.streams.send(stream_id, {
          type: "message",
          content: message,
          metadata,
          conversationId: conversationId || context.conversationId,
        });

        return { success: true, stream_id };
      },
    };
  },
};
```

```typescript
// packages/core/src/workspace-capabilities.ts
import { type Tool } from "ai";

export interface WorkspaceCapability {
  id: string;
  name: string;
  description: string;
  // Direct AI SDK Tool factory method
  toTool(context: WorkspaceExecutionContext): Tool;
}

// Example workspace capability
const workspaceDraftUpdateCapability: WorkspaceCapability = {
  id: "workspace_draft_update",
  name: "Update Workspace Draft",
  description: "Update a draft workspace configuration",
  toTool(context: WorkspaceExecutionContext): Tool {
    return {
      description: this.description,
      parameters: z.object({
        draftId: z.uuid().describe("Draft workspace ID"),
        updates: z.record(z.string(), z.unknown()).describe(
          "Configuration updates to apply (Partial<WorkspaceConfig>)",
        ),
        updateDescription: z.string().describe("Natural language description of what changed"),
      }),
      execute: async (args) => {
        const { draftId, updates, updateDescription } = args;

        // Execute with context closure
        const result = await context.drafts.update(draftId, {
          updates,
          description: updateDescription,
          updatedBy: context.agentId,
        });

        return {
          success: true,
          draftId,
          version: result.version,
        };
      },
    };
  },
};
```

### 2. **Eliminate prepareTools() Complexity**

With all capabilities returning AI SDK Tools directly, `prepareTools()` becomes trivial:

```typescript
private static async prepareTools(context: {
  tools?: Record<string, Tool>;
  mcpServers?: string[];
}): Promise<Record<string, Tool>> {
  const allTools: Record<string, Tool> = {};
  
  // All tools are already AI SDK Tools - no conversion needed
  if (context.tools) {
    Object.assign(allTools, context.tools);
  }
  
  // MCP tools already return AI SDK Tools
  if (context.mcpServers?.length > 0) {
    const mcpTools = await this.mcpManager.getToolsForServers(context.mcpServers);
    Object.assign(allTools, mcpTools);
  }
  
  return allTools;
}
```

**Key improvements:**

- **No runtime symbol checking** - All tools are already AI SDK-compatible
- **No conditional wrapping** - No need for `jsonSchema()` wrapping
- **No special cases** - `workspace_draft_update` works like any other tool
- **No deep copying** - No schema mutations to worry about

### 3. **Update ConversationAgent**

Simplify tool retrieval in ConversationAgent:

```typescript
private getDaemonCapabilityTools(streamId?: string): Record<string, Tool> {
  const tools: Record<string, Tool> = {};
  const context = this.buildExecutionContext(streamId);
  
  for (const toolName of this.agentConfig.tools || []) {
    const daemonCapability = DaemonCapabilityRegistry.getCapability(toolName);
    if (daemonCapability) {
      tools[toolName] = daemonCapability.toTool(context);
      continue;
    }
    
    const workspaceCapability = WorkspaceCapabilityRegistry.getCapability(toolName);
    if (workspaceCapability) {
      tools[toolName] = workspaceCapability.toTool(context);
    }
  }
  
  return tools;
}
```

**Benefits:**

- **No manual schema conversion** - Capabilities handle their own Tool creation
- **No adapter logic** - Direct `toTool()` method call
- **Clean context passing** - Context provided once at Tool creation
- **Type safety** - Each capability knows its exact parameter types

## Implementation Plan

### Phase 1: Update Capability Interfaces

1. Add `toTool(context): Tool` method to `DaemonCapability` interface
2. Add `toTool(context): Tool` method to `WorkspaceCapability` interface
3. Keep existing `implementation` methods for backward compatibility
4. Create example implementations showing the MCP pattern

### Phase 2: Migrate Existing Capabilities

1. Update all daemon capabilities to implement `toTool()` method
2. Update all workspace capabilities to implement `toTool()` method
3. Use clean MCP pattern: parameters as `z.object({ field: z.type().describe(...) })`
4. Ensure each capability encapsulates its context requirements

### Phase 3: Refactor Tool Handling

1. Update `getDaemonCapabilityTools()` to use `capability.toTool(context)`
2. Remove `zodSchemaToJsonSchema()` utility - no longer needed
3. Simplify `prepareTools()` to just aggregate AI SDK Tools
4. Remove all conditional wrapping logic and symbol checking

### Phase 4: Clean Up Legacy Code

1. Remove `capability-to-tool.ts` adapter file
2. Remove manual parameter mapping in ConversationAgent
3. Remove special case handling for `workspace_draft_update`
4. Update tests to verify new direct Tool creation

## Benefits of This Approach

1. **Simplicity**: Uses AI SDK's `Tool` type directly - no intermediate abstractions
2. **Type Safety**: Each capability manages its own parameter types with Zod
3. **Consistency**: All tools follow the same clean MCP pattern
4. **No Runtime Overhead**: No schema conversions, symbol checking, or deep copying
5. **Maintainability**: Each capability is self-contained with its Tool definition
6. **Developer Experience**: Clear parameter definitions with `.describe()` on each field
7. **Reduced Complexity**: Eliminates entire layers of conversion code

## Integration Testing Strategy

Before implementing the migration, we need comprehensive integration tests to verify our approach
works end-to-end:

### Test Suite: `integration-tests/llm-provider-tool-integration.test.ts`

**Test 1: Daemon Capability Tool Integration**

- **Purpose**: Verify LLM Provider can use daemon capabilities as tools
- **Test Case**: Use `stream_reply` capability through LLM Provider
- **Validation**:
  - Tool schema properly converted to AI SDK format
  - Tool execution works with real LLM calls
  - Response format matches expected `LLMResponse`
- **Mock Setup**: Use test stream ID and verify SSE endpoint calls

**Test 2: MCP Server Tool Integration**

- **Purpose**: Verify LLM Provider can use MCP tools from a test MCP server
- **Test Case**: Use simple test tools through AI SDK's MCP client with HTTP transport
- **Validation**:
  - Test MCP server spins up successfully on random port using `findAvailablePort()`
  - AI SDK's `experimental_createMCPClient` connects to test MCP server
  - Tool schemas automatically converted from MCP to AI SDK format
  - Tool execution returns expected test data
  - Integration matches current `MCPManager.getToolsForServers()` behavior
  - Server cleanly shuts down after tests complete
- **Requirements**: Test MCP server created with ModelContextProtocol TypeScript SDK

**Test 3: Mixed Tool Sources Integration**

- **Purpose**: Verify LLM Provider can use both daemon and MCP tools together
- **Test Case**: LLM call with both `stream_reply` (daemon) and test MCP server tools
- **Validation**:
  - `prepareTools()` properly aggregates tools from daemon capabilities and AI SDK MCP client
  - No schema conflicts between daemon capabilities and MCP tools
  - All tools available to LLM simultaneously with consistent AI SDK format
  - Matches current `MCPManager.getToolsForServers()` + daemon tools behavior

**Test 4: Schema Conversion Validation**

- **Purpose**: Verify current `prepareTools()` conditional logic works correctly
- **Test Case**: Test tools with and without AI SDK symbols
- **Validation**:
  - Tools without symbols get `jsonSchema()` wrapper
  - Tools with symbols pass through unchanged
  - Special cases like `workspace_draft_update` handled properly

**Test 5: Real LLM Tool Execution**

- **Purpose**: End-to-end test with actual LLM provider
- **Test Case**: LLM generates tool calls that execute successfully
- **Validation**:
  - LLM can understand tool schemas
  - Tool calls have correct parameters
  - Tool execution returns expected results
  - `LLMResponse` contains proper `toolCalls` and `toolResults`

### Test Utilities

```typescript
// integration-tests/utils/mcp-test-setup.ts
import { experimental_createMCPClient } from "ai";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod/v4";
import { findAvailablePort } from "@src/utils/port-finder.ts";

interface TestMCPServer {
  server: McpServer;
  port: number;
  url: string;
  shutdown: () => Promise<void>;
}

export async function createTestMCPServer(): Promise<TestMCPServer> {
  // Find available port using Atlas port finder utility
  const port = findAvailablePort();

  // Create MCP server with test tools
  const server = new McpServer({
    name: "test-mcp-server",
    version: "1.0.0",
  });

  // Register simple test tools
  server.registerTool("test_add", {
    title: "Test Addition Tool",
    description: "Add two numbers for testing",
    inputSchema: {
      a: z.number().describe("First number"),
      b: z.number().describe("Second number"),
    },
  }, async ({ a, b }) => ({
    content: [{
      type: "text",
      text: `Result: ${a + b}`,
    }],
  }));

  server.registerTool("test_echo", {
    title: "Test Echo Tool",
    description: "Echo back a message for testing",
    inputSchema: {
      message: z.string().describe("Message to echo"),
      metadata: z.record(z.string(), z.unknown()).optional().describe("Optional metadata"),
    },
  }, async ({ message, metadata }) => ({
    content: [{
      type: "text",
      text: `Echo: ${message}${metadata ? ` (metadata: ${JSON.stringify(metadata)})` : ""}`,
    }],
  }));

  server.registerTool("test_workspace_list", {
    title: "Test Workspace List Tool",
    description: "Return mock workspace data for testing",
    inputSchema: {
      includeSystem: z.boolean().default(false).describe("Include system workspaces"),
    },
  }, async ({ includeSystem }) => ({
    content: [{
      type: "text",
      text: JSON.stringify({
        workspaces: [
          { id: "test-workspace-1", name: "Test Workspace 1", path: "/test/workspace1" },
          { id: "test-workspace-2", name: "Test Workspace 2", path: "/test/workspace2" },
          ...(includeSystem
            ? [{ id: "system-workspace", name: "System", path: "system://test" }]
            : []),
        ],
      }),
    }],
  }));

  // Start server on random port with SSE transport
  const transport = new SSEServerTransport(`/mcp`, { port });
  await server.connect(transport);

  const url = `http://localhost:${port}/mcp`;

  return {
    server,
    port,
    url,
    shutdown: async () => {
      await server.close();
    },
  };
}

export async function createTestMCPClient(serverUrl: string) {
  // Use AI SDK's MCP client with HTTP transport to test server
  const client = await experimental_createMCPClient({
    transport: {
      type: "http",
      url: serverUrl,
    },
  });

  return client;
}

export async function getTestMCPTools(serverUrl: string) {
  const client = await createTestMCPClient(serverUrl);
  const tools = await client.tools();
  return tools;
}

// integration-tests/utils/daemon-test-setup.ts
export function setupDaemonCapabilities() {
  // Initialize daemon capabilities for testing
  // Return mock execution context
}
```

### Test Data Requirements

- **Mock Stream ID**: For testing `stream_reply` capability
- **Test MCP Server Tools**: Simple tools (`test_add`, `test_echo`, `test_workspace_list`) for
  validating MCP integration
- **Mock Workspace Data**: Test workspace objects returned by `test_workspace_list` tool
- **Schema Validation**: Verify tool schemas match expected formats between daemon and MCP tools
- **Error Scenarios**: Test invalid parameters and error handling with both daemon and MCP tools

### Success Criteria

1. **All tool sources work** - Daemon capabilities and AI SDK MCP client tools both integrate
   successfully
2. **Test MCP server works** - Test MCP server spins up on random port and accepts connections
3. **AI SDK MCP integration** - `experimental_createMCPClient` connects to test MCP server
4. **Schema consistency** - No runtime errors from schema mismatches between daemon and MCP tools
5. **Tool execution** - All tools execute with expected parameters and return valid results
6. **LLM compatibility** - Real LLM calls can understand and use all tool types consistently
7. **Performance** - No significant overhead from schema conversion or HTTP communication
8. **Behavioral parity** - AI SDK MCP client produces same results as current `MCPManager`
9. **Clean lifecycle** - Test MCP server starts and shuts down cleanly without port conflicts

These tests will validate that our current architecture works before we implement the unified tool
definition pattern.

### **AMENDED TESTING APPROACH**

**Key Changes Made:**

1. **Replaced Atlas Daemon Dependency** - Instead of requiring the Atlas daemon running on port
   8080, tests now spin up a dedicated test MCP server using the ModelContextProtocol TypeScript SDK

2. **Dynamic Port Selection** - Uses `findAvailablePort()` from `@src/utils/port-finder.ts` to
   select random available ports, preventing port conflicts during testing

3. **Self-Contained Test Server** - Created `createTestMCPServer()` utility that:
   - Registers simple test tools (`test_add`, `test_echo`, `test_workspace_list`)
   - Uses SSE transport on random port
   - Provides clean shutdown mechanism
   - Returns mock data for validation

4. **Simplified Transport** - Replaced custom `StreamableHTTPTransport` with standard HTTP transport
   to the test MCP server

5. **Controlled Lifecycle** - Test server spins up at test start and shuts down after completion,
   ensuring clean test isolation

**Benefits:**

- Tests run independently without external dependencies
- No port conflicts between test runs
- Faster test execution without full Atlas daemon startup
- Easier debugging with controlled test tools
- Better CI/CD compatibility with isolated test environment

## Migration Strategy

1. **Add `toTool()` method** to capability interfaces alongside existing structure
2. **Implement `toTool()` incrementally** - Start with a few capabilities as proof of concept
3. **Update tool consumers** to use `capability.toTool()` when available
4. **Full migration** - Convert all capabilities once pattern is proven
5. **Remove legacy code** - Delete conversion utilities and adapter files
6. **Simplify `prepareTools()`** - Remove all conditional logic
7. **Clean up tests** - Update to test direct Tool creation

## Conclusion

The current tool schema architecture suffers from unnecessary complexity due to multiple conversion
layers and inconsistent patterns.

**Key Insight**: The AI SDK's `Tool` type is already the perfect universal format. We don't need
another abstraction layer.

By having capabilities directly return AI SDK Tools with the clean MCP parameter pattern, we can:

1. **Eliminate the problematic `prepareTools()` complexity** - No more conditional wrapping or
   symbol checking
2. **Remove unnecessary abstractions** - No `UniversalToolDefinition` or conversion utilities needed
3. **Unify tool handling** - Daemon, workspace, and MCP tools all return the same `Tool` type
4. **Improve developer experience** - Self-contained capabilities with clear parameter definitions
5. **Reduce codebase complexity** - Remove entire files and conversion layers

This approach is simpler, more direct, and leverages the AI SDK's design as intended. Each
capability becomes responsible for its own Tool creation, leading to better encapsulation and easier
maintenance.
