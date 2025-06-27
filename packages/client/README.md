# @atlas/client

The official TypeScript client for interacting with the Atlas daemon API.

## Installation

This package is part of the Atlas monorepo and is available as a workspace package.

```typescript
import { AtlasClient, getAtlasClient } from "@atlas/client";
```

## Usage

### Basic Usage

```typescript
// Get the default client instance
const client = getAtlasClient();

// Check if Atlas is running
const isHealthy = await client.isHealthy();

// List workspaces
const workspaces = await client.listWorkspaces();

// Trigger a signal
await client.triggerSignal("workspace-id", "signal-name", { data: "payload" });
```

### Custom Configuration

```typescript
const client = new AtlasClient({
  url: "http://localhost:9090", // Custom URL
  timeout: 30000, // 30 second timeout
});
```

## API Reference

### Client Methods

- `isHealthy()` - Check if the Atlas daemon is running
- `getDaemonStatus()` - Get detailed daemon status
- `listWorkspaces()` - List all workspaces
- `getWorkspace(id)` - Get workspace details
- `createWorkspace(request)` - Create a new workspace
- `deleteWorkspace(id, force?)` - Delete a workspace
- `triggerSignal(workspaceId, signalId, payload)` - Trigger a signal
- `listSessions()` - List all sessions
- `getSession(id)` - Get session details
- `cancelSession(id)` - Cancel a session
- `getSessionLogs(id, options)` - Get session logs
- `streamSessionLogs(id, options)` - Stream session logs (SSE)
- `listLibraryItems(query)` - List library items
- `searchLibrary(query)` - Search library
- And more...

## Error Handling

The client provides typed errors for better error handling:

```typescript
import { AtlasApiError } from "@atlas/client";

try {
  await client.triggerSignal("workspace-id", "signal-name", {});
} catch (error) {
  if (error instanceof AtlasApiError) {
    console.error(`API Error ${error.status}: ${error.message}`);
  }
}
```

## Types

All request and response types are fully typed and exported from the package:

```typescript
import type { LibraryItem, LibrarySearchQuery, SessionInfo, WorkspaceInfo } from "@atlas/client";
```
