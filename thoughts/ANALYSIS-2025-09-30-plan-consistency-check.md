# Plan Consistency Analysis: Jobs as MCP Tools

**Date**: 2025-09-30
**Branch**: jobs-as-tools
**Plan**: thoughts/shared/plans/2025-09-25-jobs-as-mcp-tools.md
**Research**: thoughts/shared/research/2025-01-09-jobs-as-mcp-tools.md
**PR Reviewed**: #438 - Centralize workspace lifecycle

## Executive Summary

PR #438 introduced WorkspaceManager as a centralized workspace lifecycle manager. The original implementation plan needs updates to:
1. Use WorkspaceManager correctly (it doesn't have `getOrCreateWorkspace()`)
2. Pass runtime creation capability from daemon to Platform MCP Server
3. Add direct job execution method that bypasses signal lookup
4. Clarify the "bypass signals" architecture decision

## PR #438 Changes Overview

### WorkspaceManager Introduction

New centralized manager at `packages/workspace/src/manager.ts`:
- **Configuration Loading**: `getWorkspaceConfig(id)` loads merged config for workspace
- **Runtime Tracking**: `registerRuntime(id, runtime)` / `unregisterRuntime(id)` track active runtimes
- **Workspace Discovery**: `find({id, name, path})` with status reflection
- **Status Management**: "inactive" / "running" / "stopped" lifecycle states
- **Signal Registration**: Coordinates signal registrars for cron, fs-watch, etc.

### Daemon Refactoring

`apps/atlasd/src/atlas-daemon.ts` changes:
- **Line 144-148**: `getWorkspaceManager()` method added
- **Line 164-166**: WorkspaceManager created during initialization
- **Line 586-818**: `getOrCreateWorkspaceRuntime()` method handles:
  - Runtime creation with validation
  - Concurrent workspace limits (eviction)
  - Runtime registration with WorkspaceManager
  - Idle timeout management
- **Line 768-769**: Daemon registers runtime with WorkspaceManager

### What Didn't Change

- `WorkspaceRuntime` still uses signal-based job triggering
- Platform MCP Server still uses HTTP to communicate with daemon
- No direct job execution path exists yet

## Identified Inconsistencies

### 1. WorkspaceManager Missing getOrCreateWorkspace()

**Plan Says** (Phase 1):
```typescript
const runtime = await ctx.workspaceManager!.getOrCreateWorkspace(workspaceId);
```

**Reality**:
- `WorkspaceManager.getRuntime(id)` only returns existing runtime (undefined if not running)
- `AtlasDaemon.getOrCreateWorkspaceRuntime(id)` does the full creation flow:
  - Checks concurrent limits
  - Validates workspace paths
  - Loads configuration
  - Creates WorkspaceRuntime
  - Registers with WorkspaceManager
  - Sets idle timeout

**Impact**: Phase 2 job tool execution will fail because WorkspaceManager can't create runtimes.

**Fix**: Pass daemon's `getOrCreateWorkspaceRuntime()` method to Platform MCP Server.

### 2. Plan Says "Bypass Signals" But Runtime Uses Signals

**Plan Says** (Phase 3):
```typescript
// Create session directly without signal
const session = new Session({
  id: crypto.randomUUID(),
  jobName,
  params,
  notificationEmitter,
  agents: jobSpec.agents || [],
});
```

**Reality**:
- `WorkspaceRuntime.triggerJob()` (line 374-398) finds a signal for the job and calls `processSignal()`
- No direct job execution method exists
- Session creation is tied to signal processing

**Impact**: Can't bypass signals with current API.

**Fix**: Add `WorkspaceRuntime.executeJobDirectly()` method that creates sessions without signal lookup.

### 3. ToolContext Missing WorkspaceManager

**Plan Says** (Phase 1):
```typescript
export interface ToolContext {
  daemonUrl: string;
  logger: Logger;
  server: McpServer;
  workspaceManager?: WorkspaceManager;
}
```

**Reality** (`packages/mcp-server/src/tools/types.ts`):
```typescript
export interface ToolContext {
  daemonUrl: string;
  logger: Logger;
  server: McpServer;
}
```

**Impact**: Phase 1 not implemented yet.

**Fix**: Update ToolContext and Platform MCP Server constructor.

### 4. Platform MCP Server Constructor

**Plan Says** (Phase 1):
```typescript
this.mcpServer = new PlatformMCPServer({
  daemonUrl,
  logger: logger.child({ component: "platform-mcp-server" }),
  workspaceManager: this.workspaceManager,
});
```

**Reality** (`apps/atlasd/src/atlas-daemon.ts:190-194`):
```typescript
this.mcpServer = new PlatformMCPServer({
  daemonUrl,
  logger: logger.child({ component: "platform-mcp-server" }),
});
```

**Impact**: Platform MCP Server has no direct runtime access.

**Fix**: Pass workspace provider with necessary methods.

### 5. Session Completion Tracking

**Plan Adds** (Phase 3):
```typescript
async waitForCompletion(): Promise<unknown> {
  return this.completionPromise;
}
```

**Reality**: Need to verify if Session class has this or if it needs to be added.

**Impact**: Tool execution can't await job completion synchronously.

**Fix**: Verify and add if missing.

## Architecture Clarifications

### Research Evolution

The research document evolved through three stages:

1. **Initial Idea**: Keep signal triggering, attach MCP notification handles
2. **Peer Interface**: Platform MCP Server gets direct runtime access (bypass HTTP)
3. **Final Plan**: Bypass signals entirely, expose jobs as tools

The plan represents the final architectural decision.

### "Bypass Signals" Means

- Jobs exposed as individual MCP tools (`workspace_{id}_job_{name}`)
- Tool invocation creates session directly without signal lookup
- MCP notifications for progress (not SSE)
- Signal-based triggering deprecated for jobs (may remain for other uses)

### WorkspaceManager's Role

- Central source of truth for workspace metadata and configuration
- Tracks runtime lifecycle (inactive → running → stopped)
- Coordinates signal registrars (cron, fs-watch)
- Does NOT create runtimes (that's daemon's job with limits/validation)

## Corrected Implementation Approach

### Phase 1: Enable Direct Runtime Access

Pass a provider object instead of just WorkspaceManager:

```typescript
// apps/atlasd/src/atlas-daemon.ts:190-194
this.mcpServer = new PlatformMCPServer({
  daemonUrl,
  logger: logger.child({ component: "platform-mcp-server" }),
  workspaceProvider: {
    getWorkspaceManager: () => this.getWorkspaceManager(),
    getOrCreateRuntime: (id: string) => this.getOrCreateWorkspaceRuntime(id),
    getLibraryStorage: () => this.getLibraryStorage(),
  },
});
```

Update ToolContext:
```typescript
// packages/mcp-server/src/tools/types.ts
export interface WorkspaceProvider {
  getWorkspaceManager: () => WorkspaceManager;
  getOrCreateRuntime: (id: string) => Promise<WorkspaceRuntime>;
  getLibraryStorage: () => LibraryStorageAdapter;
}

export interface ToolContext {
  daemonUrl: string;
  logger: Logger;
  server: McpServer;
  workspaceProvider?: WorkspaceProvider;
}
```

### Phase 2: Dynamic Job Tool Registration

Use the provider:
```typescript
const runtime = await ctx.workspaceProvider!.getOrCreateRuntime(workspaceId);
const config = await runtime.getConfig();
```

### Phase 3: Direct Job Execution

Add new method to WorkspaceRuntime:
```typescript
// src/core/workspace-runtime.ts
async executeJobDirectly(
  jobName: string,
  params: unknown,
  notificationEmitter: MCPNotificationEmitter,
): Promise<IWorkspaceSession> {
  const jobSpec = this.config?.workspace?.jobs?.[jobName];
  if (!jobSpec) {
    throw new Error(`Job ${jobName} not found`);
  }

  // Create session directly with MCP emitter
  const sessionId = crypto.randomUUID();

  // Send EXECUTE_JOB event to state machine
  this.stateMachine.send({
    type: "EXECUTE_JOB",
    jobName,
    jobSpec,
    params,
    notificationEmitter,
  });

  // Return session (machine creates it)
  const session = this.getSession(sessionId);
  if (!session) {
    throw new Error("Failed to create job session");
  }

  return session;
}
```

This bypasses signal lookup and creates sessions directly.

## Files Requiring Updates

### Phase 1 Changes

1. `apps/atlasd/src/atlas-daemon.ts:190-194` - Pass workspace provider
2. `packages/mcp-server/src/platform-server.ts` - Accept and store provider
3. `packages/mcp-server/src/tools/types.ts` - Add WorkspaceProvider interface

### Phase 2 Changes

4. `packages/mcp-server/src/tools/jobs/register-dynamic.ts` (NEW) - Dynamic registration
5. `packages/mcp-server/src/tools/jobs/execute.ts` (NEW) - Job execution handler

### Phase 3 Changes

6. `src/core/workspace-runtime.ts` - Add `executeJobDirectly()` method
7. `src/core/workspace-runtime-machine.ts` - Add `EXECUTE_JOB` event handler
8. `src/core/session.ts` - Add `waitForCompletion()` if missing

### Phase 4 Changes

9. Error handling and cleanup as planned

## Validation Steps

Before implementing:

1. ✅ Verify WorkspaceManager API (completed)
2. ✅ Verify daemon runtime creation flow (completed)
3. ⬜ Check Session class for completion tracking
4. ⬜ Verify state machine event handling patterns
5. ⬜ Review MCP notification emitter implementation

## Recommendations

1. **Use WorkspaceProvider pattern**: Cleaner than passing WorkspaceManager alone
2. **Add executeJobDirectly()**: Required for true "bypass signals" architecture
3. **Verify Session.waitForCompletion()**: May need implementation
4. **Update plan document**: Correct the WorkspaceManager method names and approach
5. **Consider signal deprecation path**: Document migration for existing signal-based job triggers

## Conclusion

PR #438 improved the architecture significantly with WorkspaceManager centralization. The plan remains sound but needs tactical updates:

- Pass workspace provider (not just WorkspaceManager)
- Add direct job execution method
- Verify session completion tracking
- Update implementation plan with correct method names

The "bypass signals" architecture decision is valid and achievable with these corrections.
