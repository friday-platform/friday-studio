# @atlas/mcp-server

MCP server implementations for Atlas platform.

## Overview

This package provides MCP (Model Context Protocol) server implementations that expose Atlas
capabilities to external MCP clients:

- **Platform MCP Server**: Exposes platform-level capabilities (workspace management, etc.)
- **Workspace MCP Server**: Exposes workspace-specific capabilities (job execution, etc.)

## Usage

```typescript
import { PlatformMCPServer, WorkspaceMCPServer } from "@atlas/mcp-server";

// Platform server
const platformServer = new PlatformMCPServer({
  daemonUrl: "http://localhost:8080",
});
await platformServer.start();

// Workspace server
const workspaceServer = new WorkspaceMCPServer({
  workspaceRuntime,
  workspaceConfig,
});
await workspaceServer.start();
```

## Features

- Platform-level capabilities via daemon API
- Workspace-specific job execution
- Rate limiting and security controls
- Job discoverability filtering
- Comprehensive logging and monitoring
