# @atlas/mcp

Core MCP (Model Context Protocol) functionality for Atlas.

## Overview

This package provides the core MCP management functionality for Atlas, including:

- **MCPManager**: Handles MCP server lifecycle and tool registration using Vercel AI SDK
- **MCPServerRegistry**: Workspace-level registry for MCP server configurations
- **MCP Adapter**: Remote agent communication adapter for MCP

## Usage

```typescript
import { MCPManager, MCPServerRegistry } from "@atlas/mcp";

// Use MCP components in your Atlas application
const mcpManager = new MCPManager(dependencies);
const registry = new MCPServerRegistry(workspaceId, configLoader);
```

## Architecture

This package implements MCP functionality with:

- Hierarchical configuration resolution (platform → workspace)
- Dual-mode resolution (direct configs vs registry)
- Integration with Vercel AI SDK for MCP client functionality
- Official MCP TypeScript SDK compatibility

## Migration Notes

### Future Considerations

**⚠️ MCP Adapter Migration Note**: The MCP adapter (`src/adapters/mcp-adapter.ts`) is currently in
this package for consolidation purposes. In future migrations, consider moving it to a dedicated
adapter package (e.g., `@atlas/adapters`) along with other remote agent adapters for better
separation of concerns.

### Package Dependencies

- `@atlas/config` - MCP schemas and configuration types
- `@atlas/storage` - Configuration adapters
- `ai` - Vercel AI SDK for MCP client functionality
- `@modelcontextprotocol/sdk` - Official MCP SDK

## Testing

```bash
deno task test
```

## Related Packages

- `@atlas/mcp-server` - Platform and workspace MCP server implementations
- `@atlas/mcp-tools` - MCP tool proxy utilities
- `@atlas/config` - Configuration schemas including MCP settings
