# HTTP Client Migration Plan

This document outlines the migration plan from direct `fetch` calls to using the centralized
`@atlas/client` package in CLI commands.

## Available AtlasClient Methods

### Connection & Status

- `isHealthy()` - Check if Atlas daemon is running and accessible
- `getDaemonStatus()` - Get comprehensive daemon status information
- `shutdown()` - Shutdown the daemon gracefully

### Workspace Operations

- `listWorkspaces()` - List all registered workspaces
- `getWorkspace(workspaceId)` - Get detailed workspace information
- `getWorkspacePath(workspaceId)` - Get workspace path without triggering validation
- `createWorkspace(request)` - Create a new workspace
- `deleteWorkspace(workspaceId, force?)` - Delete a workspace
- `addWorkspace(request)` - Add a single workspace by path
- `addWorkspaces(request)` - Add multiple workspaces in batch
- `createWorkspaceFromTemplate(request)` - Create workspace from template
- `createWorkspaceFromConfig(params)` - Create workspace from YAML configuration

### Template Operations

- `listWorkspaceTemplates()` - List available workspace templates

### Session Management

- `listSessions()` - List all sessions across workspaces
- `getSession(sessionId)` - Get specific session details
- `cancelSession(sessionId)` - Cancel a running session
- `getSessionLogs(sessionId, options?)` - Get session logs with filtering
- `streamSessionLogs(sessionId, options?)` - Stream session logs via SSE
- `listWorkspaceSessions(workspaceId)` - List sessions in specific workspace

### Signal Operations

- `triggerSignal(workspaceId, signalId, payload?)` - Trigger signal via daemon API
- `triggerWorkspaceSignal(port, signalName, payload)` - Trigger signal on workspace server
- `listSignals(workspaceId)` - List signals in a workspace
- `describeSignal(workspaceId, signalName, workspacePath)` - Get signal configuration

### Agent Management

- `listAgents(workspaceId)` - List agents in a workspace
- `describeAgent(workspaceId, agentId)` - Get agent details

### Job Management

- `listJobs(workspaceId)` - List jobs in a workspace
- `describeJob(workspaceId, jobName, workspacePath)` - Get job configuration

### Library Operations

- `listLibraryItems(query?)` - List library items with filtering
- `getLibraryItem(itemId, includeContent?)` - Get specific library item
- `searchLibrary(query)` - Search library items
- `listTemplates()` - List available templates
- `generateFromTemplate(templateId, data, options?)` - Generate content from template
- `getLibraryStats()` - Get library statistics
- `deleteLibraryItem(itemId)` - Delete library item
- `listWorkspaceLibraryItems(workspaceId, query?)` - List library items in workspace
- `searchWorkspaceLibrary(workspaceId, query)` - Search library in workspace
- `getWorkspaceLibraryItem(workspaceId, itemId, includeContent?)` - Get workspace library item

### Error Handling

- `handleFetchError(error)` - Standardized error handling for fetch operations

## Current Fetch Usage Analysis

### Files Using Direct Fetch Calls

#### 1. `src/cli/commands/interactive.tsx`

- **Current Usage**: Imports `getAtlasClient` and properly uses client methods
- **Status**: ✅ Already migrated - Uses `client.getWorkspacePath()`, `client.isHealthy()`,
  `client.getLibraryItem()`

#### 2. `src/cli/commands/daemon/start.tsx`

- **Line 108**: `fetch(\`http://localhost:${port}/health\`)` - Health check
- **Migration**: Replace with `client.isHealthy()`

#### 3. `src/cli/commands/session/get.tsx`

- **Line 49**: `fetch(\`http://localhost:${port}/sessions/${argv.id}\`)` - Get session details
- **Migration**: Replace with `client.getSession(argv.id)`

#### 4. `src/cli/commands/library/search.tsx`

- **Line 94**: `fetch(\` ${serverUrl}/api/library/search?${params}\`)` - Search library
- **Migration**: Replace with `client.searchLibrary(query)`

#### 5. `src/cli/commands/daemon/status.tsx`

- **Line 34**: Uses `fetchDaemonStatus(port)` helper function
- **Migration**: Replace with `client.getDaemonStatus()`

#### 6. `src/cli/commands/daemon/restart.tsx`

- **Line 58**: `fetch(\`http://localhost:${port}/api/daemon/status\`)` - Get daemon status
- **Line 79**: `fetch(\`http://localhost:${port}/api/daemon/shutdown\`)` - Shutdown daemon
- **Line 160**: `fetch(\`http://localhost:${port}/health\`)` - Health check
- **Migration**: Replace with `client.getDaemonStatus()`, `client.shutdown()`, `client.isHealthy()`

#### 7. `src/cli/commands/library/templates.tsx`

- **Line 77**: `fetch(\` ${serverUrl}/api/library/templates?${params}\`)` - List templates
- **Migration**: Replace with `client.listTemplates()`

#### 8. `src/cli/commands/library/stats.tsx`

- **Line 64**: `fetch(\`${serverUrl}/api/library/stats\`)` - Get library stats
- **Migration**: Replace with `client.getLibraryStats()`

#### 9. `src/cli/commands/library/get.tsx`

- **Line 86**: `fetch(\` ${serverUrl}/api/library/${argv.id}?${params}\`)` - Get library item
- **Line 91**: `fetch(\`${serverUrl}/api/library\`)` - List all items for prefix search
- **Line 100**: `fetch(\` ${serverUrl}/api/library/${matchingItem.id}?${params}\`)` - Get with full
  ID
- **Migration**: Replace with `client.getLibraryItem()` and `client.listLibraryItems()`

#### 10. `src/cli/commands/library/generate.tsx`

- **Line 132**: `fetch(\`${serverUrl}/api/library/generate\`)` - Generate from template
- **Migration**: Replace with `client.generateFromTemplate()`

#### 11. `src/cli/commands/library/list.tsx`

- **Status**: ✅ Already migrated - Uses `client.listLibraryItems()`

#### 12. `src/cli/commands/daemon/stop.tsx`

- **Line 38**: `fetch(\`http://localhost:${port}/api/daemon/status\`)` - Get daemon status
- **Line 67**: `fetch(\`http://localhost:${port}/api/daemon/shutdown\`)` - Shutdown daemon
- **Line 110**: `fetch(\`http://localhost:${port}/health\`)` - Health check
- **Migration**: Replace with `client.getDaemonStatus()`, `client.shutdown()`, `client.isHealthy()`

#### 13. `src/cli/commands/session/cancel.tsx`

- **Line 47**: `fetch(\`http://localhost:${port}/sessions/${argv.id}\`)` - Get session
- **Line 85**: `fetch(\`http://localhost:${port}/sessions/${argv.id}/cancel\`)` - Cancel session
- **Migration**: Replace with `client.getSession()` and `client.cancelSession()`

## Migration Tasks

### High Priority (Core Daemon Operations)

1. ✅ **Migrate daemon/start.tsx** - Replace health check with `client.isHealthy()`
2. ✅ **Migrate daemon/status.tsx** - Replace status fetch with `client.getDaemonStatus()`
3. ✅ **Migrate daemon/restart.tsx** - Replace status, shutdown, health checks with client methods
4. ✅ **Migrate daemon/stop.tsx** - Replace status, shutdown, health checks with client methods

### Medium Priority (Session Operations)

5. ✅ **Migrate session/get.tsx** - Replace session fetch with `client.getSession()`
6. ✅ **Migrate session/cancel.tsx** - Replace session operations with client methods

### Medium Priority (Library Operations)

7. ✅ **Migrate library/search.tsx** - Replace search with `client.searchLibrary()`
8. ✅ **Migrate library/templates.tsx** - Replace templates fetch with `client.listTemplates()`
9. ✅ **Migrate library/stats.tsx** - Replace stats fetch with `client.getLibraryStats()`
10. ✅ **Migrate library/get.tsx** - Replace library item fetches with client methods
11. ✅ **Migrate library/generate.tsx** - Replace generate with `client.generateFromTemplate()`

## Implementation Notes

### Import Pattern

All files should import the client using:

```typescript
import { getAtlasClient } from "@atlas/client";
```

### Error Handling

Use the client's built-in error handling:

```typescript
try {
  const result = await client.someMethod();
} catch (error) {
  const errorResult = client.handleFetchError(error);
  console.error(errorResult.error);
  Deno.exit(1);
}
```

### Port Configuration

The client uses `DEFAULT_ATLAS_URL` (localhost:8080) by default. For custom ports:

```typescript
const client = getAtlasClient({ url: `http://localhost:${port}` });
```

### Consistency Benefits

- Standardized error handling and timeout behavior
- Automatic response validation with Zod schemas
- Centralized URL construction and parameter handling
- Better type safety with TypeScript interfaces
- Consistent API patterns across all CLI commands

## Testing Approach

1. Update one file at a time
2. Test each command after migration
3. Ensure error cases still work correctly
4. Verify timeout behavior is preserved
5. Check that JSON output formats remain consistent

## Migration Status

### ✅ MIGRATION COMPLETE!

**All 11 targeted files have been successfully migrated from direct `fetch()` calls to AtlasClient
methods.**

### Files Migrated (11/11):

- ✅ daemon/start.tsx
- ✅ daemon/status.tsx
- ✅ daemon/restart.tsx
- ✅ daemon/stop.tsx
- ✅ session/get.tsx
- ✅ session/cancel.tsx
- ✅ library/search.tsx
- ✅ library/templates.tsx
- ✅ library/stats.tsx
- ✅ library/get.tsx
- ✅ library/generate.tsx

### Already Using Client (2/2):

- ✅ interactive.tsx (already used client methods)
- ✅ library/list.tsx (already used client methods)

## Completion Criteria ✅

- ✅ All direct `fetch` calls replaced with client methods
- ✅ All commands tested and functional
- ✅ No regression in CLI functionality
- ✅ Consistent error handling across all commands
- ✅ Better type safety and validation
- ✅ Enhanced AtlasClient schemas to match daemon API responses
