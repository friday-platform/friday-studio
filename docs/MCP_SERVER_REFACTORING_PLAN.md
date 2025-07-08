# MCP Server Refactoring Plan

## Executive Summary

This document outlines the plan to refactor the Atlas MCP server to simplify its architecture,
remove modality abstractions, and improve modularity by extracting each tool into its own file.

### Key Changes from Feedback

1. **Workspace Context**: Since the MCP server now serves multiple workspaces through the daemon
   (not per-workspace instances), workspace context must be passed through tool parameters rather
   than constructor injection
2. **Tool Types**: Using a custom `ToolHandler` interface that aligns with MCP SDK's `registerTool`
   pattern, as the SDK doesn't export a specific tool definition type
3. **Context Injection**: Each tool receives a shared `ToolContext` with daemon URL and logger,
   while workspace-specific data comes through input parameters

## Current State Analysis

### Architecture Overview

- **Platform Server**: `packages/mcp-server/src/platform-server.ts` (2497 lines)
- **Daemon Integration**: Exposed via `/mcp` endpoint in `apps/atlasd/src/atlas-daemon.ts`
- **Transport**: Uses `StreamableHTTPTransport` from `@hono/mcp`
- **Tool Registration**: Inline within `setupTools()` method
- **Modality**: Dynamic tool availability based on `ServerMode` (internal/public)

### Key Components

1. **ServerMode System**: Dynamic tool filtering based on server mode
2. **Tool Categories**: Internal vs Public tools with metadata
3. **Helper Methods**: Query builders, error handlers, retry logic
4. **Security Wrappers**: Workspace MCP check, job discoverability check

## Refactoring Objectives

### 1. Simplification

Since the MCP server is now served through atlasd:

- Remove standalone StdioServerTransport
- Remove daemon health checks (redundant when served by daemon)
- Simplify initialization (no need for separate start/stop methods)
- Remove client config generation methods
- Reduce abstraction layers

### 2. Remove Modality

Replace dynamic tool registration with static registration:

- Remove ServerMode enum and MODE_CONFIGS
- Remove ToolCategory and tool filtering logic
- Remove `registerToolIfAllowed()` wrapper
- Register all tools statically (future authorization will handle access)
- Remove tool-categories.ts and associated types

### 3. Modularity

Extract each tool into its own file:

- One tool per file in `packages/mcp-server/src/tools/`
- Consistent structure for each tool module
- Centralized tool registry for registration
- Shared utilities for common operations

## Proposed Architecture

### Directory Structure

```
packages/mcp-server/
├── src/
│   ├── index.ts              # Main exports
│   ├── platform-server.ts    # Simplified MCP server class
│   ├── tools/
│   │   ├── index.ts         # Tool registry and exports
│   │   ├── types.ts         # Shared tool types
│   │   ├── utils.ts         # Shared utilities
│   │   │
│   │   ├── workspace/       # Workspace management tools
│   │   │   ├── list.ts
│   │   │   ├── create.ts
│   │   │   ├── delete.ts
│   │   │   └── describe.ts
│   │   │
│   │   ├── session/         # Session management tools
│   │   │   ├── describe.ts
│   │   │   └── cancel.ts
│   │   │
│   │   ├── jobs/            # Job management tools
│   │   │   ├── list.ts
│   │   │   └── describe.ts
│   │   │
│   │   ├── signals/         # Signal management tools
│   │   │   ├── list.ts
│   │   │   └── trigger.ts
│   │   │
│   │   ├── agents/          # Agent management tools
│   │   │   ├── list.ts
│   │   │   └── describe.ts
│   │   │
│   │   ├── library/         # Library management tools
│   │   │   ├── list.ts
│   │   │   ├── get.ts
│   │   │   ├── store.ts
│   │   │   ├── stats.ts
│   │   │   └── templates.ts
│   │   │
│   │   └── drafts/          # Draft management tools
│   │       ├── create.ts
│   │       ├── update.ts
│   │       ├── validate.ts
│   │       ├── publish.ts
│   │       ├── show.ts
│   │       └── list.ts
│   └── types.ts             # Core MCP server types
```

### Tool Module Structure

Each tool module will follow this pattern:

```typescript
// Example: tools/workspace/list.ts
import { z } from "zod/v4";
import type { ToolHandler } from "../types.ts";

export const workspaceListTool: ToolHandler = {
  name: "workspace_list",
  description: "Discover available Atlas workspaces...",
  inputSchema: z.object({
    // Schema definition
  }),
  handler: async (args, { daemonUrl, logger }) => {
    // Implementation using shared context
    const response = await fetch(`${daemonUrl}/api/workspaces`);
    // ...
  },
};
```

### Tool Type Definition

The `ToolHandler` type is designed to work with the MCP SDK's `registerTool` method:

```typescript
// types.ts
import { z } from "zod/v4";
import type { Logger } from "../platform-server.ts";

export interface ToolContext {
  daemonUrl: string;
  logger: Logger;
}

export interface ToolHandler<TInput = any> {
  name: string;
  description: string;
  inputSchema: z.ZodSchema<TInput>;
  handler: (args: TInput, context: ToolContext) => Promise<{
    content: Array<{
      type: "text";
      text: string;
    }>;
  }>;
}
```

Note: The MCP SDK doesn't export a specific `ToolDefinition` type, but our `ToolHandler` interface
aligns with the SDK's tool registration pattern. The SDK's `registerTool` method accepts:

- Tool name (string)
- Tool options (description, inputSchema)
- Handler function

Our structure provides type safety while maintaining compatibility with the SDK.

### Workspace Context Handling

Since the MCP server now serves multiple workspaces through the daemon, workspace context must be
handled per-tool invocation:

1. **For tools requiring workspace context**: Include `workspaceId` in the input schema
2. **For context auto-injection** (e.g., library_store): Pass context through tool input parameters
3. **Remove** constructor-level workspace context injection

Example for context-aware tools:

```typescript
// tools/library/store.ts
export const libraryStoreTool: ToolHandler = {
  name: "library_store",
  description: "Store content in library...",
  inputSchema: z.object({
    // Include workspace context in schema
    workspace_id: z.string().optional(),
    session_id: z.string().optional(),
    agent_ids: z.array(z.string()).optional(),
    // ... other fields
  }),
  handler: async (args, { daemonUrl, logger }) => {
    // Context is now part of args, not injected
    const payload = {
      workspace_id: args.workspace_id,
      session_id: args.session_id,
      // ...
    };
  },
};
```

### Simplified Platform Server

```typescript
export class PlatformMCPServer {
  private server: McpServer;
  private daemonUrl: string;
  private logger: Logger;

  constructor(dependencies: PlatformMCPServerDependencies) {
    // Simple initialization
    this.server = new McpServer({
      name: "atlas-platform",
      version: "1.0.0",
    });

    // Create shared context for all tools
    const toolContext: ToolContext = {
      daemonUrl: this.daemonUrl,
      logger: this.logger,
    };

    // Register all tools with shared context
    registerTools(this.server, toolContext);
  }

  getServer(): McpServer {
    return this.server;
  }
}

// Tool registration
function registerTools(server: McpServer, context: ToolContext) {
  // Import all tools
  const tools = getAllTools();

  // Register each tool
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.inputSchema,
      },
      async (args) => tool.handler(args, context),
    );
  }
}
```

## Implementation Steps

### Phase 1: Extract Tools (Modularization)

1. Create tool directory structure
2. Define shared types and utilities
3. Extract each tool into its own module:
   - Move tool definition (name, description, schema)
   - Move handler implementation
   - Preserve error handling and logging
4. Create tool registry for centralized registration
5. Update imports and registrations

### Phase 2: Remove Modality

1. Remove ServerMode enum and related types
2. Remove tool-categories.ts
3. Remove dynamic tool filtering logic
4. Simplify tool registration (no more `registerToolIfAllowed`)
5. Remove mode configuration from constructor
6. Update tests to remove mode-specific behavior

### Phase 3: Simplify Architecture

1. Remove standalone server methods (start, stop)
2. Remove daemon health checks
3. Remove client config generation
4. Simplify constructor and dependencies
5. Move helper methods to shared utilities
6. Reduce class to essential MCP server wrapper

### Phase 4: Cleanup and Testing

1. Update package exports
2. Update daemon integration if needed
3. Run comprehensive tests
4. Update documentation
5. Remove deprecated files

## Benefits

### Maintainability

- Each tool in its own file (easier to find and modify)
- Consistent structure across all tools
- Shared utilities reduce duplication
- Clear separation of concerns

### Simplicity

- No dynamic tool registration complexity
- No mode-based filtering logic
- Straightforward tool registration
- Minimal abstraction layers

### Extensibility

- Easy to add new tools (just create a new file)
- Tools can be grouped logically in subdirectories
- Shared utilities can be extended
- Future authorization can be added at transport level

### Performance

- No runtime tool filtering
- Direct tool registration
- Reduced initialization overhead
- Smaller memory footprint

## Key Architecture Changes

### Workspace Context Migration

The most significant change is how workspace context is handled:

**Before (Per-Workspace Server):**

```typescript
// Server instantiated with workspace context
const server = new PlatformMCPServer({
  workspaceContext: {
    workspaceId: "workspace-123",
    sessionId: "session-456",
    agentId: "agent-789",
  },
});

// Tools auto-inject context
workspace_id: workspace_id || this.workspaceContext?.workspaceId;
```

**After (Daemon-Wide Server):**

```typescript
// Server has no workspace context
const server = new PlatformMCPServer({
  daemonUrl: "http://localhost:8080",
  logger: logger,
});

// Context passed through tool parameters
inputSchema: z.object({
  workspace_id: z.string().optional(),
  session_id: z.string().optional(),
  // ...
});
```

### Impact on Existing Tools

Tools that previously relied on auto-injected context must be updated:

- `library_store`: Must accept workspace_id, session_id, agent_ids as parameters
- `workspace_draft_create`: Must accept sessionId/conversationId as parameters
- Security wrappers (`withWorkspaceMCPCheck`): Move validation into tool handlers

### Request Flow Example

```
MCP Client Request → Daemon /mcp endpoint → PlatformMCPServer
                                                    ↓
                                            Tool Handler Called
                                                    ↓
                                        Input includes workspace_id
                                                    ↓
                                    Handler validates & routes to daemon API
                                                    ↓
                                        Daemon API uses workspace_id
```

## Migration Notes

### Breaking Changes

- ServerMode parameter removed from constructor
- Tool availability no longer dynamic (all tools registered)
- Workspace context no longer auto-injected
- Some internal methods removed or moved
- Tools that relied on `this.workspaceContext` must be updated

### Non-Breaking Changes

- Tool names remain the same
- Core handler logic preserved
- Daemon integration unchanged
- MCP protocol compliance maintained
- Tool input schemas extended (backward compatible with optional fields)

## Future Considerations

### Authorization System

When implementing authorization:

- Add middleware at transport/daemon level
- Use tool metadata for access control
- Implement role-based access control
- Keep authorization separate from tool implementation

### Tool Discovery

Consider implementing:

- Tool metadata endpoint
- Dynamic documentation generation
- Tool capability descriptions
- Usage examples and patterns

### Testing Strategy

- Unit tests for each tool module
- Integration tests for tool registry
- End-to-end tests via daemon
- Performance benchmarks
- **Workspace Context Tests**: Ensure tools correctly handle workspace_id from parameters

### Transition Strategy

To minimize disruption during refactoring:

1. Implement new modular structure alongside existing code
2. Gradually migrate tools one category at a time
3. Run parallel testing to ensure compatibility
4. Switch over once all tools are migrated and tested
5. Remove old code in final cleanup phase

## Detailed Implementation Guide

### Prerequisites

- Familiarity with TypeScript, Deno, and the MCP SDK
- Understanding of the Atlas architecture and daemon integration
- Access to the Atlas codebase at `/packages/mcp-server/`

### Step-by-Step Implementation

#### Phase 1.1: Create Tool Directory Structure and Shared Types

1. **Create directory structure**:
   ```bash
   cd packages/mcp-server/src
   mkdir -p tools/{workspace,session,jobs,signals,agents,library,drafts}
   ```

2. **Create `tools/types.ts`**:
   ```typescript
   import { z } from "zod/v4";
   import type { Logger } from "../platform-server.ts";

   export interface ToolContext {
     daemonUrl: string;
     logger: Logger;
   }

   export interface ToolHandler<TInput = any> {
     name: string;
     description: string;
     inputSchema: z.ZodSchema<TInput>;
     handler: (args: TInput, context: ToolContext) => Promise<{
       content: Array<{
         type: "text";
         text: string;
       }>;
     }>;
   }
   ```

3. **Create `tools/utils.ts`** for shared utilities:
   ```typescript
   // Move helper methods from platform-server.ts:
   // - buildLibraryQueryParams
   // - handleDaemonResponse
   // - fetchWithTimeout
   // - isRetryableError
   // - calculateRetryDelay
   ```

4. **Create `tools/index.ts`** for tool registry:
   ```typescript
   import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
   import type { ToolContext } from "./types.ts";

   export function registerTools(server: McpServer, context: ToolContext) {
     // Tool registration will be added here
   }

   export function getAllTools() {
     // Return array of all tool handlers
   }
   ```

#### Phase 1.2: Extract Workspace Management Tools

For each tool (workspace_list, workspace_create, workspace_delete, workspace_describe):

1. **Create tool file** (e.g., `tools/workspace/list.ts`):
   ```typescript
   import { z } from "zod/v4";
   import type { ToolHandler } from "../types.ts";

   export const workspaceListTool: ToolHandler = {
     name: "workspace_list",
     description: "Discover available Atlas workspaces...",
     inputSchema: z.object({}),
     handler: async (_args, { daemonUrl, logger }) => {
       // Copy implementation from platform-server.ts lines 102-149
       // Update to use context instead of this.daemonUrl
     },
   };
   ```

2. **Extract handler logic**:
   - Copy the handler implementation from `platform-server.ts`
   - Replace `this.daemonUrl` with `daemonUrl` from context
   - Replace `this.logger` with `logger` from context
   - Import any needed utilities from `utils.ts`

3. **Update tool registry** in `tools/index.ts`:
   ```typescript
   import { workspaceListTool } from "./workspace/list.ts";

   const tools = [
     workspaceListTool,
     // Add more tools as extracted
   ];
   ```

#### Phase 1.3-1.7: Extract Remaining Tool Categories

Repeat Phase 1.2 process for:

- **Session tools**: session_describe, session_cancel
- **Job tools**: workspace_jobs_list, workspace_jobs_describe
- **Signal tools**: workspace_signals_list, workspace_signals_trigger
- **Agent tools**: workspace_agents_list, workspace_agents_describe
- **Library tools**: library_list, library_get, library_store, library_stats, library_templates
- **Draft tools**: All 7 draft management tools

**Special Considerations**:

1. **For workspace-context tools** (e.g., library_store):
   - Add workspace_id, session_id, agent_ids to input schema
   - Remove auto-injection logic
   - Update handler to use parameters directly

2. **For security-wrapped tools**:
   - Move `withWorkspaceMCPCheck` logic into handler
   - Add workspace validation at start of handler
   - Return appropriate MCP error codes

#### Phase 2: Remove ServerMode and Tool Filtering

1. **Delete files**:
   - `src/tool-categories.ts`
   - `src/types.ts` (the one with ServerMode)

2. **Update platform-server.ts**:
   - Remove all imports related to ServerMode
   - Remove `mode` from constructor parameters
   - Remove `registerToolIfAllowed` method
   - Remove `getToolsForMode`, `isToolAllowedForMode` calls
   - Remove mode-related properties and methods

3. **Simplify tool registration**:
   - Replace conditional registration with direct registration
   - Remove mode checks and filtering logic

#### Phase 3: Simplify PlatformMCPServer

1. **Remove unnecessary methods**:
   - `start()` and `stop()` methods
   - `checkDaemonHealth()`
   - `createClientConfig()`
   - Mode-related getters

2. **Simplify constructor**:
   ```typescript
   constructor(dependencies: PlatformMCPServerDependencies) {
     this.daemonUrl = dependencies.daemonUrl || "http://localhost:8080";
     this.logger = dependencies.logger;
     
     this.server = new McpServer({
       name: "atlas-platform",
       version: "1.0.0",
     });
     
     const toolContext: ToolContext = {
       daemonUrl: this.daemonUrl,
       logger: this.logger,
     };
     
     registerTools(this.server, toolContext);
   }
   ```

3. **Remove workspace context**:
   - Remove `workspaceContext` property
   - Remove all references to `this.workspaceContext`

#### Phase 4: Cleanup and Testing

1. **Update exports** in `src/index.ts`
2. **Update daemon integration** if needed
3. **Run tests**:
   ```bash
   deno test packages/mcp-server/
   ```
4. **Update documentation**
5. **Remove old code** from platform-server.ts

### Validation Checklist

After each phase, verify:

- [ ] All extracted tools maintain the same functionality
- [ ] Tool names and schemas remain unchanged
- [ ] Error handling and logging preserved
- [ ] No references to removed types/methods
- [ ] Tests pass for migrated tools
- [ ] Daemon integration still works

### Common Pitfalls to Avoid

1. **Don't forget to update imports** when moving helper methods
2. **Preserve error codes** - MCP clients may depend on specific codes
3. **Maintain backward compatibility** in tool schemas
4. **Test workspace context flow** thoroughly
5. **Check for circular dependencies** when organizing utilities

### Testing Each Tool

For each extracted tool:

1. Create a test file in `tools/[category]/[toolname].test.ts`
2. Test input validation
3. Test successful daemon API calls
4. Test error handling
5. Test workspace context handling (where applicable)

## Conclusion

This refactoring will significantly simplify the MCP server architecture while improving
maintainability and extensibility. The modular structure will make it easier to add new tools and
maintain existing ones, while the removal of dynamic modality will reduce complexity and improve
performance.
