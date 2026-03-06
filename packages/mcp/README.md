# @atlas/mcp

Ephemeral MCP (Model Context Protocol) client for Atlas.

## Overview

Connects to MCP servers, fetches tools, returns a dispose callback.
No pooling, no sharing, no ref counting.

## Usage

```typescript
import { createMCPTools } from "@atlas/mcp";

const { tools, dispose } = await createMCPTools(serverConfigs, logger);
// ... use tools ...
await dispose();
```

## Package Dependencies

- `@atlas/config` - MCP schemas and configuration types
- `@atlas/core` - Credential resolution
- `ai` - Vercel AI SDK for MCP client functionality
- `@modelcontextprotocol/sdk` - Official MCP SDK

## Testing

```bash
deno task test packages/mcp/src/create-mcp-tools.test.ts
```
