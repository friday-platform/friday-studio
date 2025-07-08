# @atlas/mcp-server

MCP (Model Context Protocol) server implementations for the Atlas AI agent orchestration platform.

## Overview

This package provides two MCP servers:

- **Platform MCP Server**: Exposes platform-wide capabilities through the Atlas daemon, including
  tools and resources
- **Workspace MCP Server**: Provides workspace-specific job execution with security controls

## Usage

### Platform MCP Server

The platform server is instantiated by the Atlas daemon and exposed via the `/mcp` endpoint:

```typescript
import { PlatformMCPServer } from "@atlas/mcp-server";

// Create platform server (typically done in atlasd)
const platformServer = new PlatformMCPServer({
  daemonUrl: "http://localhost:8080", // Daemon API endpoint
  logger: logger, // Logger instance
});

// Get the MCP server instance for transport integration
const mcpServer = platformServer.getServer();
```

The platform server automatically registers:

- **Tools**: For workspace management, job execution, library operations, and more
- **Resources**: Including the workspace configuration reference at `atlas://reference/workspace`

### Workspace MCP Server

The workspace server provides job execution capabilities for a specific workspace:

```typescript
import { WorkspaceMCPServer } from "@atlas/mcp-server";

// Create workspace server with runtime and config
const workspaceServer = new WorkspaceMCPServer({
  workspaceRuntime: {
    listJobs: async () => [...],
    triggerJob: async (name, payload) => {...},
    describeJob: async (name) => {...},
  },
  workspaceConfig: config,  // Workspace configuration
  logger: logger,
});

// Start the server (uses stdio transport)
await workspaceServer.start();
```

## Tool Development Guide

### Tool Definition Structure

Each tool in the platform server follows a consistent pattern that aligns with
[MCP tool definition best practices](https://modelcontextprotocol.io/docs/concepts/tools#tool-definition-structure):

```typescript
// Example from src/tools/fs/ls.ts
import { z } from "zod";
import type { ToolContext } from "../types.ts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createSuccessResponse } from "../types.ts";

export function registerLsTool(server: McpServer, ctx: ToolContext) {
  server.registerTool(
    "atlas:list",
    {
      description:
        "Lists files and directories in a given path. The path parameter can be either absolute or relative. You can optionally provide an array of glob patterns to ignore with the ignore parameter. You should generally prefer the Glob and Grep tools, if you know which directories to search.",
      inputSchema: {
        path: z.string().optional().describe(
          "The path to the directory to list (can be absolute or relative)",
        ),
        ignore: z.array(z.string()).optional().describe(
          "List of glob patterns to ignore",
        ),
      },
    },
    async (params) => {
      // Implementation
    },
  );
}
```

### Tool Development Best Practices

#### 1. Tool Naming

- Use the `atlas:` namespace prefix for all tools
- Use descriptive, action-oriented names (e.g., `atlas:workspace_create`, not `atlas:workspace`)
- Follow snake_case convention for multi-word names
- Group related tools with common prefixes (e.g., `atlas:library_*` for library operations)

#### 2. Writing Tool Descriptions

Tool descriptions should be:

- **Clear and concise**: Explain what the tool does in one or two sentences
- **Action-oriented**: Start with a verb (e.g., "Lists", "Creates", "Retrieves")
- **Context-aware**: Include relevant constraints or recommendations
- **User-focused**: Written for AI agents to understand when and how to use the tool

```typescript
// Good description
description: "Lists files and directories in a given path. The path parameter can be either absolute or relative. You can optionally provide an array of glob patterns to ignore with the ignore parameter. You should generally prefer the Glob and Grep tools, if you know which directories to search.";

// Poor description
description: "File listing tool";
```

#### 3. Input Schema Design

Use Zod v4 for type-safe input validation:

```typescript
inputSchema: {
  // Required parameters
  workspaceId: z.string().describe(
    "The workspace ID to operate on"
  ),
  
  // Optional parameters with clear descriptions
  path: z.string().optional().describe(
    "The path to the directory to list (can be absolute or relative)"
  ),
  
  // Arrays with item validation
  ignore: z.array(z.string()).optional().describe(
    "List of glob patterns to ignore"
  ),
  
  // Enums for constrained choices
  format: z.enum(["json", "text"]).optional().default("json").describe(
    "Output format for the results"
  ),
  
  // Numbers with constraints
  limit: z.number().min(1).max(1000).optional().default(100).describe(
    "Maximum number of results to return"
  ),
}
```

#### 4. Parameter Descriptions

Every parameter should have a `.describe()` call that:

- Explains what the parameter does
- Includes format requirements or examples
- Notes if it's context-dependent
- Mentions default values if not obvious

```typescript
// Good parameter descriptions
workspaceId: z.string().optional().describe(
  "Target workspace ID. If not provided, the current workspace context will be used"
),

since: z.string().optional().describe(
  "ISO 8601 timestamp to filter results (e.g., 2024-01-15T10:30:00Z)"
),

tags: z.array(z.string()).optional().describe(
  "Filter by tags. Multiple tags are combined with OR logic"
),
```

#### 5. Workspace Context Handling

Since the platform server is daemon-wide, workspace context must be explicit:

```typescript
// Always include workspaceId when operations are workspace-scoped
inputSchema: {
  workspaceId: z.string().describe(
    "The workspace ID to operate on"
  ),
  // Other parameters...
}

// For operations that might use current context
inputSchema: {
  workspaceId: z.string().optional().describe(
    "Target workspace ID. If not provided, the current workspace context will be used"
  ),
  sessionId: z.string().optional().describe(
    "Active session ID for context-aware operations"
  ),
}
```

#### 6. Error Handling

Provide meaningful error messages that help AI agents understand what went wrong:

```typescript
try {
  const validated = inputSchema.parse(params);
  // Tool logic...
  return createSuccessResponse(result);
} catch (error) {
  if (error instanceof z.ZodError) {
    // Validation errors should be clear about what's wrong
    return createErrorResponse(
      new Error(`Invalid parameters: ${error.errors.map((e) => e.message).join(", ")}`),
    );
  }

  // Include context in error messages
  return createErrorResponse(
    new Error(`Failed to list workspace jobs: ${error.message}`),
  );
}
```

#### 7. Response Structure

Return structured data that's easy for AI agents to parse and use:

```typescript
// Good: Structured response with metadata
return createSuccessResponse({
  title: "Workspace Libraries",
  items: libraries,
  metadata: {
    total: libraries.length,
    hasMore: hasMore,
    limit: limit,
  },
});

// Avoid: Unstructured text responses
return createSuccessResponse(
  `Found ${libraries.length} libraries...`,
);
```

### Testing Your Tools

Ensure your tool handles:

1. **Valid inputs**: Normal use cases
2. **Invalid inputs**: Missing required params, wrong types
3. **Edge cases**: Empty results, timeouts, API errors
4. **Security**: Unauthorized access, MCP disabled workspaces

```bash
deno test packages/mcp-server/
```

## Resources

The platform server exposes MCP Resources that provide static data and content for AI agents.

### Available Resources

#### Workspace Configuration Reference

- **URI**: `atlas://reference/workspace`
- **Type**: `text/yaml`
- **Description**: Comprehensive reference showing all Atlas workspace configuration options

This resource provides a complete, well-documented example of workspace configuration including:

- Signal definitions (CLI, HTTP webhooks, scheduled)
- Job configurations with triggers and execution strategies
- Agent definitions with prompts and MCP tool attachments
- MCP server configurations
- Advanced features like supervision levels and memory settings

### Accessing Resources

AI agents can discover and read resources through standard MCP operations:

```typescript
// List available resources
const resources = await mcp.resources.list();
// Returns: [{ uri: "atlas://reference/workspace", name: "...", description: "...", mimeType: "text/yaml" }]

// Read resource content
const reference = await mcp.resources.read({
  uri: "atlas://reference/workspace",
});
// Returns: { contents: [{ uri: "...", mimeType: "text/yaml", text: "..." }] }
```

### Resource Development

Resources follow a similar pattern to tools but provide read-only data:

```typescript
// src/resources/workspace-reference.ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ResourceContext } from "./types.ts";

export function registerWorkspaceReferenceResource(
  server: McpServer,
  context: ResourceContext,
) {
  server.registerResource(
    "workspace-reference", // Resource name
    "atlas://reference/workspace", // Resource URI
    {
      name: "Workspace Configuration Reference",
      description: "Comprehensive reference showing all Atlas workspace configuration options",
      mimeType: "text/yaml",
    },
    () => { // Read callback
      return {
        contents: [{
          uri: "atlas://reference/workspace",
          mimeType: "text/yaml",
          text: referenceContent,
        }],
      };
    },
  );
}
```

## Security Architecture

### Platform Server Security

The platform server implements several security layers:

1. **Workspace MCP Validation**: Tools that operate on workspaces check if MCP is enabled
2. **Job Discoverability**: Jobs must be explicitly marked as discoverable in workspace config
3. **Parameter Validation**: All inputs validated with Zod schemas before processing
4. **Daemon API Gateway**: All operations go through authenticated daemon endpoints

### Workspace Server Security

The workspace server provides additional controls:

1. **Capability Filtering**: Only exposes capabilities explicitly configured as discoverable
2. **Rate Limiting**:
   - Requests per hour limits
   - Concurrent session limits
3. **Job Access Control**: Only discoverable jobs can be triggered
4. **No Platform Access**: Cannot access session management or agent introspection

Example workspace configuration:

```yaml
server:
  mcp:
    enabled: true
    discoverable:
      capabilities:
        - "workspace_jobs_*" # Allow job listing and description
      jobs:
        - "build-*" # Allow all build jobs
        - "deploy-prod" # Allow specific deploy job
    rate_limits:
      requests_per_hour: 1000
      concurrent_sessions: 5
```

## Architectural Patterns

### Tool Implementation Pattern

Each tool follows a consistent pattern:

1. **Single Responsibility**: One tool per file, focused on a specific operation
2. **Schema-First**: Input validation using Zod v4 schemas
3. **Context Injection**: Receives `ToolContext` with daemon URL and logger
4. **Error Handling**: Consistent error responses with MCP error codes
5. **Logging**: Structured logging for debugging and monitoring

### Resource Implementation Pattern

Resources follow a similar pattern to tools:

1. **Static Content**: Resources provide read-only data, not dynamic operations
2. **URI Scheme**: Use the `atlas://` scheme for all Atlas resources
3. **Context Injection**: Receives `ResourceContext` with logger
4. **Registration**: Resources are registered with name, URI, metadata, and read callback
5. **Content Types**: Support standard MIME types (text/yaml, application/json, etc.)
