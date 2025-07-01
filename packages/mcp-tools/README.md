# @atlas/mcp-tools

MCP client tools and utilities for Atlas platform.

## Overview

This package provides client-side MCP tools and utilities for Atlas:

- **MCP Proxy**: Routes MCP calls between workspaces and platform
- **Configuration Helpers**: Generate MCP client configurations
- **Transport Utilities**: Handle MCP communication

## Usage

```typescript
import { MCPProxy } from "@atlas/mcp-tools";

// Create proxy for cross-workspace communication
const proxy = new MCPProxy({
  atlasConfig,
  federationManager,
  platformMCPServer,
  workspaceMCPServers,
});

// Route MCP call
const result = await proxy.routeCall(transport, call);
```

## Features

- Cross-workspace MCP communication
- Federation-aware routing
- Remote Atlas instance support
- Transport configuration helpers
- Security and access control
