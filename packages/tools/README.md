# @atlas/tools

Atlas Tool Registry for AI SDK compatibility. This package provides all Atlas MCP tools formatted for use with the AI SDK's tool calling pattern.

## Features

- **AI SDK Compatible**: All tools follow the AI SDK `tool()` pattern with Zod schemas
- **Categorized Tools**: Tools organized by functionality (filesystem, workspace, session, etc.)
- **Registry Management**: Centralized tool registry with flexible access patterns
- **Type Safe**: Full TypeScript support with proper type inference
- **Modular**: Import specific categories or individual tools as needed

## Installation

This package is part of the Atlas monorepo and should be imported using the local import system.

## Usage

### Import All Tools

```typescript
import { atlasTools, getAtlasToolRegistry } from "@atlas/tools";

// Get all tools as a single object
const tools = atlasTools;

// Or use the registry for more control
const registry = getAtlasToolRegistry();
const allTools = registry.getAllTools();
```

### Create Custom Registry Instance

```typescript
import { AtlasToolRegistry } from "@atlas/tools";

// Create a new registry instance (useful for testing)
const customRegistry = new AtlasToolRegistry();
const tools = customRegistry.getAllTools();
```

### Import by Category

```typescript
import { conversationTools, filesystemTools, workspaceTools } from "@atlas/tools";

// Use specific tool categories
const readTool = filesystemTools.atlas_read;
const listWorkspaces = workspaceTools.atlas_workspace_list;
const streamReply = conversationTools.atlas_stream_reply;
```

### Import Individual Tools

```typescript
import { filesystemTools } from "@atlas/tools/filesystem";
import { workspaceTools } from "@atlas/tools/workspace";
import { conversationTools } from "@atlas/tools/conversation";

const readTool = filesystemTools.atlas_read;
const createWorkspace = workspaceTools.atlas_workspace_create;
const streamReply = conversationTools.atlas_stream_reply;
```

### Using the Registry

```typescript
import { getAtlasToolRegistry, type ToolCategory } from "@atlas/tools";

const registry = getAtlasToolRegistry();

// Get tools by category
const fsTools = registry.getToolsByCategory("filesystem");
const allTools = registry.getToolsByCategory("all");

// Get tool by name
const readTool = registry.getToolByName("atlas_read");

// Check if tool exists
if (registry.hasTools("atlas_read")) {
  // Tool exists
}

// Get registry info
const summary = registry.getSummary();
const categories = registry.getAvailableCategories();
const toolNames = registry.getAllToolNames();
```

## Tool Categories

### Filesystem Tools (`filesystem`)

- `atlas_read` - Read files with pagination and line limits
- `atlas_write` - Write files with directory creation
- `atlas_list` - List directory contents with filtering
- `atlas_glob` - File pattern matching with glob syntax
- `atlas_grep` - Content search with regex support

### Workspace Tools (`workspace`)

- `atlas_workspace_list` - List all workspaces
- `atlas_workspace_create` - Create new workspaces
- `atlas_workspace_delete` - Delete workspaces
- `atlas_workspace_describe` - Get workspace details

### Session Tools (`session`)

- `atlas_session_cancel` - Cancel active sessions
- `atlas_session_describe` - Get session details

### Job Tools (`job`)

- `atlas_workspace_jobs_list` - List workspace jobs
- `atlas_workspace_jobs_describe` - Get job details

### Signal Tools (`signal`)

- `atlas_workspace_signals_list` - List workspace signals
- `atlas_workspace_signals_trigger` - Trigger signals

### Agent Tools (`agent`)

- `atlas_workspace_agents_list` - List workspace agents
- `atlas_workspace_agents_describe` - Get agent details

### Library Tools (`library`)

- `atlas_library_list` - Browse library items
- `atlas_library_get` - Get library items
- `atlas_library_store` - Store library items
- `atlas_library_stats` - Get library statistics
- `atlas_library_templates` - List templates

### Draft Tools (`draft`)

- `atlas_workspace_draft_create` - Create workspace drafts
- `atlas_list_session_drafts` - List session drafts
- `atlas_show_draft_config` - Show draft configuration
- `atlas_workspace_draft_update` - Update drafts
- `atlas_workspace_draft_validate` - Validate drafts
- `atlas_publish_draft_to_workspace` - Publish drafts
- `atlas_delete_draft_config` - Delete drafts

### System Tools (`system`)

- `atlas_fetch` - Fetch web content
- `atlas_bash` - Execute bash commands
- `atlas_notify_email` - Send email notifications

### Conversation Tools (`conversation`)

- `atlas_stream_reply` - Send streaming replies via Server-Sent Events for real-time communication
- `atlas_conversation_storage` - Manage conversation history with support for storing, retrieving, listing, and deleting conversation data

## Tool Format

All tools follow the AI SDK pattern:

```typescript
import { z } from "zod/v4";
import { tool } from "ai";

const exampleTool = tool({
  description: "Description of what the tool does",
  parameters: z.object({
    param1: z.string().describe("Parameter description"),
    param2: z.number().optional().describe("Optional parameter"),
  }),
  execute: async ({ param1, param2 }) => {
    // Tool implementation
    return { result: "success" };
  },
});
```

## Configuration

The tools use a default daemon URL that can be configured:

```typescript
import { defaultContext } from "@atlas/tools/utils";

// Configure daemon URL (default: http://localhost:3000)
defaultContext.daemonUrl = "http://your-daemon:3000";
```

## Error Handling

All tools include comprehensive error handling and will throw descriptive errors:

```typescript
try {
  const result = await filesystemTools.atlas_read.execute({
    filePath: "/path/to/file.txt",
  });
} catch (error) {
  console.error("Tool execution failed:", error.message);
}
```

## Development

### Building

```bash
deno task check  # Type check
deno task lint   # Lint code
deno task fmt    # Format code
```

### Testing

```bash
deno task test              # Run all tests
deno task test:unit         # Run unit tests only
deno task test:watch        # Run tests in watch mode
```

### Testing Your Own Tools

The package provides a non-singleton registry design that makes testing easy:

```typescript
import { AtlasToolRegistry } from "@atlas/tools";
import { assertEquals } from "@std/assert";

Deno.test("custom registry test", () => {
  const registry = new AtlasToolRegistry();
  const tools = registry.getAllTools();

  assertEquals("atlas_read" in tools, true);
  assertEquals(typeof tools.atlas_read.execute, "function");
});
```

## License

Part of the Atlas project.
