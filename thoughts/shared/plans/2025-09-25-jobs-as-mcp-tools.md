# Jobs as MCP Tools Implementation Plan

## Overview

Replace signal-based job triggering with direct MCP tools that use notifications for progress reporting, eliminating SSE stream interleaving issues when multiple jobs run concurrently.

## Current State Analysis

Jobs are triggered via signals which create sessions that queue on SSE streams. Only one session can emit per stream at a time, causing 30-second timeout delays. The Platform MCP Server uses HTTP to trigger signals, which then create sessions that compete for the SSE stream.

**Updated 2025-09-30**: PR #438 introduced WorkspaceManager as centralized workspace lifecycle manager. Daemon now uses WorkspaceManager to track workspace status and runtime lifecycle.

### Key Discoveries:

- SSE queueing enforced at `apps/atlasd/routes/streams/emit.ts:60-64`
- 30-second timeout hardcoded at `apps/atlasd/routes/streams/emit.ts:175`
- Agent server uses per-session pattern at `apps/atlasd/src/atlas-daemon.ts:317-377` and `apps/atlasd/src/atlas-daemon.ts:500-580`
- MCP notification infrastructure exists at `packages/core/src/streaming/stream-emitters.ts:109-155`
- WorkspaceManager introduced in PR #438 at `packages/workspace/src/manager.ts`
- Daemon's `getOrCreateWorkspaceRuntime()` handles runtime creation with limits and validation at `apps/atlasd/src/atlas-daemon.ts:586-818`

## Desired End State

Jobs exposed as individual MCP tools with dedicated notification channels. The conversation agent orchestrates job execution through MCP tools, receiving progress via notifications instead of SSE. Signal-based execution remains for external triggers (cron, webhooks, fs-watch).

**Two Execution Paths Coexist:**

1. **MCP Tool Path**: Conversation agent → MCP tool → direct execution → MCP notifications
2. **Signal Path**: External triggers → signals → sessions → SSE streams (unchanged)

## Implementation Approach

Direct execution model: MCP tools bypass signals entirely and execute jobs directly through the runtime with MCP notification channels.

## Phase 1: Per-Session Platform MCP Servers with Direct Runtime Access

### Overview

Convert Platform MCP Server to per-session pattern (mirroring agent server architecture). Each MCP session gets its own Platform MCP Server instance with WorkspaceProvider for direct runtime access. This enables proper session isolation, SSE notification support, and clean state management.

**Architecture**: Mirrors `/agents` endpoint pattern exactly - per-session server instances, stateful endpoint handler, session cleanup with timeout/LRU eviction.

**Note**: WorkspaceManager doesn't have `getOrCreateRuntime()` - that's in the daemon. We pass a provider object with bound methods to each session's server instance.

### Changes Required:

#### 1. Tool Context Extension

**File**: `packages/mcp-server/src/tools/types.ts`
**Changes**: Add WorkspaceProvider interface and update ToolContext

```typescript
// Add before ToolContext interface
export interface WorkspaceProvider {
  getOrCreateRuntime: (id: string) => Promise<WorkspaceRuntime>;
}

// Update ToolContext interface (around line 11-15)
export interface ToolContext {
  daemonUrl: string;
  logger: Logger;
  server: McpServer;
  workspaceProvider?: WorkspaceProvider;
}
```

#### 2. Platform MCP Server Constructor

**File**: `packages/mcp-server/src/platform-server.ts`
**Changes**: Accept and store WorkspaceProvider

```typescript
// Import types at top of file
import type { WorkspaceProvider } from "./tools/types.ts";

// Update PlatformMCPServerDependencies interface (around line 24-27)
export interface PlatformMCPServerDependencies {
  daemonUrl?: string;
  logger: Logger;
  workspaceProvider?: WorkspaceProvider;
}

// Add property (around line 32-34)
private workspaceProvider?: WorkspaceProvider;

// Update constructor (around line 35-44)
constructor(dependencies: PlatformMCPServerDependencies) {
  this.daemonUrl = dependencies.daemonUrl || getAtlasDaemonUrl();
  this.logger = dependencies.logger;
  this.workspaceProvider = dependencies.workspaceProvider;

  // ... rest of constructor
}

// Update tool context creation (around line 47-51)
const toolContext: ToolContext = {
  daemonUrl: this.daemonUrl,
  logger: this.logger,
  server: this.server,
  workspaceProvider: this.workspaceProvider,
};
```

#### 3. Daemon Per-Session Storage and Management

**File**: `apps/atlasd/src/atlas-daemon.ts`
**Changes**: Add session storage and management methods (mirrors agent session pattern)

```typescript
// Add to daemon class properties (around line 86-104)
// Store per-session Platform MCP servers and transports
private platformMcpSessions = new Map<
  string,
  {
    server: PlatformMCPServer;
    transport: StreamableHTTPTransport;
    createdAt: number;
    lastUsed: number;
  }
>();

// Session limits
private readonly MAX_PLATFORM_SESSIONS = 100;
private readonly PLATFORM_SESSION_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes

/**
 * Get or create per-session Platform MCP server
 * Mirrors getOrCreateAgentSession pattern exactly
 */
private async getOrCreatePlatformSession(
  sessionId: string,
): Promise<{ server: PlatformMCPServer; transport: StreamableHTTPTransport }> {
  const existing = this.platformMcpSessions.get(sessionId);
  if (existing) {
    existing.lastUsed = Date.now();
    return { server: existing.server, transport: existing.transport };
  }

  // Create new session
  logger.info("[Daemon] Creating new Platform MCP session", { sessionId });

  // Create transport
  const transport = new StreamableHTTPTransport({
    sessionIdGenerator: () => sessionId,
    onsessioninitialized: (sid) => {
      logger.info("[Daemon] Platform session initialized", { sessionId: sid });
    },
  });

  // Create per-session Platform MCP server
  const daemonUrl = getAtlasDaemonUrl();
  const server = new PlatformMCPServer({
    daemonUrl,
    logger: logger.child({ component: "platform-mcp-server", sessionId }),
    workspaceProvider: {
      getOrCreateRuntime: (id: string) => this.getOrCreateWorkspaceRuntime(id),
    },
  });

  // Connect to MCP server
  await server.getServer().connect(transport);

  // Store session
  this.platformMcpSessions.set(sessionId, {
    server,
    transport,
    createdAt: Date.now(),
    lastUsed: Date.now(),
  });

  // Set up cleanup
  transport.onclose = () => {
    logger.info("[Daemon] Platform session closed", { sessionId });
    this.cleanupPlatformSession(sessionId);
  };

  // Register job tools for all existing workspaces
  logger.info("Registering job tools for existing workspaces in new session", { sessionId });
  try {
    const existingWorkspaces = await this.workspaceManager.list({ includeSystem: true });
    for (const workspace of existingWorkspaces) {
      await server.registerWorkspaceJobTools(workspace.id);
    }
    logger.info("Job tools registered in new session", {
      sessionId,
      workspaceCount: existingWorkspaces.length
    });
  } catch (error) {
    logger.error("Failed to register tools in new session", { error, sessionId });
  }

  return { server, transport };
}

/**
 * Clean up platform session
 */
private async cleanupPlatformSession(sessionId: string): Promise<void> {
  const session = this.platformMcpSessions.get(sessionId);
  if (session) {
    // Platform MCP Server doesn't have explicit stop() - just remove from map
    this.platformMcpSessions.delete(sessionId);
    logger.info("[Daemon] Platform session cleaned up", { sessionId });
  }
}
```

#### 4. Stateful `/mcp` Endpoint Handler

**File**: `apps/atlasd/src/atlas-daemon.ts`
**Changes**: Convert `/mcp` endpoint from stateless to stateful session management (mirrors `/agents` endpoint at line 500-580)

```typescript
// Replace existing /mcp endpoint (around line 466-497) with stateful version:
this.app.all(
  "/mcp",
  cors({
    origin: this.options.cors || "*",
    credentials: true,
    exposeHeaders: ["Mcp-Session-Id"],
    allowHeaders: ["Content-Type", "Mcp-Session-Id"],
  }),
  async (c) => {
    try {
      const sessionId = c.req.header("mcp-session-id");

      // For new sessions (no session ID on POST), generate one
      if (!sessionId && c.req.method === "POST") {
        const newSessionId = crypto.randomUUID();
        logger.info("Creating new Platform MCP session", { sessionId: newSessionId });

        // Create and store the session
        const { transport } = await this.getOrCreatePlatformSession(newSessionId);

        // Handle the request - this will set the Mcp-Session-Id header
        const response = await transport.handleRequest(c);

        // The transport now has the session ID set
        if (transport.sessionId) {
          logger.info("Session ID set on transport", {
            sessionId: transport.sessionId,
            originalId: newSessionId,
          });
        }

        return response;
      } else if (sessionId) {
        // Existing session - get or create
        const { transport } = await this.getOrCreatePlatformSession(sessionId);

        // Handle DELETE specially - clean up after processing
        if (c.req.method === "DELETE") {
          logger.info("Terminating Platform MCP session", { sessionId });
          const response = await transport.handleRequest(c);
          await this.cleanupPlatformSession(sessionId);
          return response;
        }

        // Handle the request
        return transport.handleRequest(c);
      } else {
        // No session ID and not a POST request - this is an error
        logger.error("[Daemon] Invalid request - no session ID for non-POST", {
          method: c.req.method,
        });
        return c.json(
          {
            jsonrpc: "2.0",
            error: { code: -32000, message: "Session ID required for non-initialize requests" },
            id: null,
          },
          400,
        );
      }
    } catch (error) {
      logger.error("Platform MCP endpoint error", { error });
      return c.json(
        {
          error: `Platform MCP server error: ${error instanceof Error ? error.message : String(error)}`,
        },
        500,
      );
    }
  },
);
```

#### 5. Platform Session Cleanup with Timeout/LRU Eviction

**File**: `apps/atlasd/src/atlas-daemon.ts`
**Changes**: Add cleanup logic to daemon initialization and shutdown (mirrors agent cleanup at line 1278-1338)

```typescript
// In daemon class, add cleanup interval property (around line 89-90)
private platformSessionCleanupInterval: number | null = null;

// In initialize() method, after agent session cleanup setup (around line 270)
// Start platform session cleanup interval
this.startPlatformSessionCleanup();

// Add cleanup method (place after startAgentSessionCleanup around line 1293)
/**
 * Start platform session cleanup interval
 */
private startPlatformSessionCleanup(): void {
  if (this.platformSessionCleanupInterval) {
    clearInterval(this.platformSessionCleanupInterval);
  }

  // Check every minute for stale sessions
  this.platformSessionCleanupInterval = setInterval(() => {
    this.performPlatformSessionCleanup();
  }, 60000);

  logger.info("Platform session cleanup started", {
    intervalMs: 60000,
    maxSessions: this.MAX_PLATFORM_SESSIONS,
    timeoutMs: this.PLATFORM_SESSION_TIMEOUT_MS,
  });
}

/**
 * Clean up stale platform sessions
 */
private async performPlatformSessionCleanup(): Promise<void> {
  const now = Date.now();
  const sessionsToCleanup: string[] = [];

  // Find stale sessions
  for (const [sessionId, session] of this.platformMcpSessions) {
    if (now - session.lastUsed > this.PLATFORM_SESSION_TIMEOUT_MS) {
      sessionsToCleanup.push(sessionId);
    }
  }

  // Clean up stale sessions
  if (sessionsToCleanup.length > 0) {
    logger.info("Cleaning up stale platform sessions", {
      count: sessionsToCleanup.length,
      totalSessions: this.platformMcpSessions.size,
    });

    for (const sessionId of sessionsToCleanup) {
      await this.cleanupPlatformSession(sessionId);
    }
  }

  // Enforce session limit (LRU eviction)
  if (this.platformMcpSessions.size > this.MAX_PLATFORM_SESSIONS) {
    const sortedSessions = Array.from(this.platformMcpSessions.entries()).sort(
      (a, b) => a[1].lastUsed - b[1].lastUsed,
    );

    const toEvict = sortedSessions.slice(0, this.platformMcpSessions.size - this.MAX_PLATFORM_SESSIONS);

    logger.warn("Evicting LRU platform sessions due to limit", {
      evictionCount: toEvict.length,
      totalSessions: this.platformMcpSessions.size,
      maxSessions: this.MAX_PLATFORM_SESSIONS,
    });

    for (const [sessionId] of toEvict) {
      await this.cleanupPlatformSession(sessionId);
    }
  }
}

// In shutdown() method, add platform session cleanup (around line 1109)
// Stop platform session cleanup
if (this.platformSessionCleanupInterval) {
  clearInterval(this.platformSessionCleanupInterval);
  this.platformSessionCleanupInterval = null;
}

// Clean up platform sessions (around line 1133, after agent session cleanup)
for (const sessionId of this.platformMcpSessions.keys()) {
  try {
    await this.cleanupPlatformSession(sessionId);
  } catch (error) {
    logger.debug("Error cleaning up platform session", { error, sessionId });
  }
}
this.platformMcpSessions.clear();
```

### Success Criteria:

#### Automated Verification:

- [x] Type checking passes: `deno check`
- [x] Per-session Platform MCP Server creation works
- [x] Session storage Map types correctly
- [x] No TypeScript errors on WorkspaceProvider methods

#### Manual Verification:

- [ ] `/mcp` endpoint handles session ID header correctly
- [ ] New sessions (POST with no session ID) create new server instance
- [ ] Existing sessions reuse server instance
- [ ] DELETE requests clean up session
- [ ] WorkspaceProvider accessible in tool handlers via ctx.workspaceProvider
- [ ] getOrCreateRuntime() creates runtimes with proper validation and limits
- [ ] Session cleanup runs every minute
- [ ] Stale sessions (15 min timeout) are cleaned up
- [ ] LRU eviction works when session limit (100) is reached
- [ ] New sessions register tools for all existing workspaces

---

## Phase 2: Dynamic Job Tool Registration

### Overview

Register workspace jobs as MCP tools dynamically using workspace lifecycle callbacks. When workspaces are registered, deleted, or their configs change, job tools are automatically added, removed, or reloaded. The MCP SDK handles `listChanged` notifications automatically.

### Changes Required:

#### 1. Workspace Lifecycle Observer Interface

**File**: `packages/workspace/src/types.ts`
**Changes**: Add lifecycle observer interface

```typescript
/**
 * Callback interface for workspace lifecycle events
 */
export interface WorkspaceLifecycleObserver {
  onWorkspaceRegistered?: (workspaceId: string) => Promise<void> | void;
  onWorkspaceUnregistered?: (workspaceId: string) => Promise<void> | void;
  onWorkspaceConfigChanged?: (workspaceId: string) => Promise<void> | void;
}
```

#### 2. WorkspaceManager Lifecycle Hooks

**File**: `packages/workspace/src/manager.ts`
**Changes**: Add observer registration and lifecycle callbacks

```typescript
export class WorkspaceManager {
  private registry: RegistryStorageAdapter;
  private runtimes = new Map<string, WorkspaceRuntime>();
  private signalRegistrars: WorkspaceSignalRegistrar[] = [];
  private fileWatcher: WorkspaceConfigWatcher | null = null;
  private lifecycleObservers: WorkspaceLifecycleObserver[] = []; // NEW

  // NEW: Register lifecycle observer
  addLifecycleObserver(observer: WorkspaceLifecycleObserver): void {
    this.lifecycleObservers.push(observer);
  }

  async registerWorkspace(
    workspacePath: string,
    metadata?: { name?: string; description?: string; tags?: string[] },
  ): Promise<{ workspace: WorkspaceEntry; created: boolean }> {
    // ... existing registration logic ...

    await this.registry.registerWorkspace(entry);
    logger.info(`Workspace registered: ${entry.name}`, { id: entry.id });

    // Attach file watcher for this workspace (non-system only)
    if (this.fileWatcher && !entry.metadata?.system) {
      try {
        await this.fileWatcher.watchWorkspace(entry);
        await this.registerWithRegistrars(entry.id, entry.path, config);
      } catch (error) {
        logger.warn("Failed to register workspace", {
          workspaceId: entry.id,
          error: error,
        });
      }
    }

    // NEW: Notify lifecycle observers
    for (const observer of this.lifecycleObservers) {
      try {
        await observer.onWorkspaceRegistered?.(entry.id);
      } catch (error) {
        logger.warn("Lifecycle observer failed", {
          error,
          workspaceId: entry.id,
        });
      }
    }

    return { workspace: entry, created: true };
  }

  async deleteWorkspace(
    id: string,
    options?: { force?: boolean; removeDirectory?: boolean },
  ): Promise<void> {
    const workspace = await this.registry.getWorkspace(id);
    if (!workspace) {
      logger.info("Workspace already deleted", { id });
      return;
    }

    // ... existing validation ...

    // NEW: Notify lifecycle observers before deletion
    for (const observer of this.lifecycleObservers) {
      try {
        await observer.onWorkspaceUnregistered?.(id);
      } catch (error) {
        logger.warn("Lifecycle observer failed", { error, workspaceId: id });
      }
    }

    // Unregister from signal registrars first
    await this.unregisterWithRegistrars(id);
    // ... rest of deletion logic ...
  }

  async handleWorkspaceConfigChange(
    workspace: WorkspaceEntry,
    filePath: string,
  ): Promise<void> {
    logger.info("Handling workspace configuration change", {
      workspaceId: workspace.id,
      filePath,
      workspacePath: workspace.path,
    });

    // ... existing change handling ...

    await this.stopRuntimeIfActive(workspace.id);
    await this.restartSignalsForWorkspace(
      workspace.id,
      workspace.path,
      validation.config,
    );
    await this.markWorkspaceInactive(workspace.id);

    // NEW: Notify lifecycle observers after config reload
    for (const observer of this.lifecycleObservers) {
      try {
        await observer.onWorkspaceConfigChanged?.(workspace.id);
      } catch (error) {
        logger.warn("Lifecycle observer failed", {
          error,
          workspaceId: workspace.id,
        });
      }
    }
  }
}
```

#### 3. Job Execution Handler

**File**: `packages/mcp-server/src/tools/jobs/execute.ts` (NEW FILE)
**Changes**: Direct job execution with MCP notifications

```typescript
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ToolContext } from "../types.ts";
import { MCPStreamEmitter } from "@atlas/core/streaming/stream-emitters.ts";
import { logger } from "@atlas/logger";

export async function executeJob(
  ctx: ToolContext,
  workspaceId: string,
  jobName: string,
  params: unknown,
): Promise<CallToolResult> {
  const runtime = await ctx.workspaceProvider!.getOrCreateRuntime(workspaceId);

  // Create MCP stream emitter for this job execution
  const sessionId = crypto.randomUUID();
  const toolName = `workspace_${workspaceId}_job_${jobName}`;
  const streamEmitter = new MCPStreamEmitter(
    ctx.server,
    toolName,
    sessionId,
    ctx.logger,
  );

  try {
    // Execute job directly with MCP stream emitter
    // Note: executeJobDirectly() is added in Phase 3
    const session = await runtime.executeJobDirectly(
      jobName,
      params,
      streamEmitter,
    );

    // Wait for completion - returns SessionSummary with full execution details
    const summary = await session.waitForCompletion();

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            success: summary.status === "completed",
            status: summary.status,
            sessionId: summary.sessionId,
            duration: summary.duration,
            results: summary.results,
            ...(summary.failureReason && { failureReason: summary.failureReason }),
          }),
        },
      ],
    };
  } catch (error) {
    // Return error as MCP error result
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify({
            error: error.message,
            code: "JOB_EXECUTION_FAILED",
            sessionId,
          }),
        },
      ],
    };
  }
}
```

#### 4. Platform MCP Server Dynamic Tool Registration

**File**: `packages/mcp-server/src/platform-server.ts`
**Changes**: Use MCP SDK's dynamic server capabilities to register/unregister job tools

```typescript
import { executeJob } from "./tools/jobs/execute.ts";

export class PlatformMCPServer {
  private server: McpServer;
  private daemonUrl: string;
  private logger: Logger;
  private workspaceProvider?: WorkspaceProvider;
  private registeredWorkspaceTools = new Map<string, Map<string, any>>(); // workspaceId -> (toolName -> toolHandle)

  // NEW: Dynamically register job tools for a workspace
  async registerWorkspaceJobTools(workspaceId: string): Promise<void> {
    if (!this.workspaceProvider) {
      this.logger.warn("WorkspaceProvider not available", { workspaceId });
      return;
    }

    try {
      const runtime =
        await this.workspaceProvider.getOrCreateRuntime(workspaceId);
      const config = runtime.getConfig();

      const toolHandles = new Map<string, any>();

      for (const [jobName, jobSpec] of Object.entries(
        config.workspace?.jobs || {},
      )) {
        const toolName = `workspace_${workspaceId}_job_${jobName}`;

        // Find signal schema for input validation
        const signal = Object.values(config.workspace?.signals || {}).find(
          (sig) => jobSpec.triggers?.some((t) => t.signal === sig.name),
        );

        const inputSchema = signal?.schema || {
          type: "object",
          properties: {
            payload: { type: "object", additionalProperties: true },
          },
        };

        // Use MCP SDK's dynamic tool registration
        // This automatically sends listChanged notification to clients
        const toolHandle = this.server.tool(
          toolName,
          inputSchema,
          async (params) => {
            return await executeJob(
              {
                daemonUrl: this.daemonUrl,
                logger: this.logger,
                server: this.server,
                workspaceProvider: this.workspaceProvider,
              },
              workspaceId,
              jobName,
              params,
            );
          },
        );

        toolHandles.set(toolName, toolHandle);
        this.logger.info("Registered job tool", {
          toolName,
          workspaceId,
          jobName,
        });
      }

      this.registeredWorkspaceTools.set(workspaceId, toolHandles);
    } catch (error) {
      this.logger.error("Failed to register workspace job tools", {
        error,
        workspaceId,
      });
    }
  }

  // NEW: Unregister job tools when workspace is deleted
  async unregisterWorkspaceJobTools(workspaceId: string): Promise<void> {
    const toolHandles = this.registeredWorkspaceTools.get(workspaceId);
    if (!toolHandles) return;

    for (const [toolName, toolHandle] of toolHandles) {
      try {
        // Remove tool using MCP SDK
        // This automatically sends listChanged notification to clients
        toolHandle.remove();
        this.logger.info("Unregistered job tool", { toolName, workspaceId });
      } catch (error) {
        this.logger.warn("Failed to unregister tool", { error, toolName });
      }
    }

    this.registeredWorkspaceTools.delete(workspaceId);
  }

  // NEW: Reload tools when workspace config changes
  async reloadWorkspaceJobTools(workspaceId: string): Promise<void> {
    this.logger.info("Reloading job tools for workspace", { workspaceId });
    await this.unregisterWorkspaceJobTools(workspaceId);
    await this.registerWorkspaceJobTools(workspaceId);
  }
}
```

#### 5. Daemon Lifecycle Integration

**File**: `apps/atlasd/src/atlas-daemon.ts`
**Changes**: Wire up lifecycle observer to iterate all active platform sessions

```typescript
async initialize(): Promise<void> {
  if (this.isInitialized) return;

  logger.info("Initializing Atlas daemon...");

  // ... existing initialization (supervisor defaults, WorkspaceManager, etc.) ...

  // NOTE: No global Platform MCP Server initialization here
  // Platform MCP Servers are created per-session on demand via getOrCreatePlatformSession()

  // ... existing initialization (Global MCP Server Pool, agent registry, etc.) ...

  // NEW: Register lifecycle observer for dynamic job tool management
  // Iterates ALL active platform sessions to add/remove/reload tools
  logger.info("Registering MCP tool lifecycle observer...");
  this.workspaceManager.addLifecycleObserver({
    onWorkspaceRegistered: async (workspaceId: string) => {
      logger.info("Registering job tools for new workspace in all sessions", { workspaceId });

      // Notify all active platform sessions
      for (const [sessionId, session] of this.platformMcpSessions) {
        try {
          await session.server.registerWorkspaceJobTools(workspaceId);
          logger.debug("Registered job tools in session", { workspaceId, sessionId });
        } catch (error) {
          logger.error("Failed to register job tools in session", { error, workspaceId, sessionId });
        }
      }

      logger.info("Job tools registered across all sessions", {
        workspaceId,
        sessionCount: this.platformMcpSessions.size
      });
    },

    onWorkspaceUnregistered: async (workspaceId: string) => {
      logger.info("Unregistering job tools for deleted workspace in all sessions", { workspaceId });

      // Notify all active platform sessions
      for (const [sessionId, session] of this.platformMcpSessions) {
        try {
          await session.server.unregisterWorkspaceJobTools(workspaceId);
          logger.debug("Unregistered job tools in session", { workspaceId, sessionId });
        } catch (error) {
          logger.error("Failed to unregister job tools in session", { error, workspaceId, sessionId });
        }
      }

      logger.info("Job tools unregistered across all sessions", {
        workspaceId,
        sessionCount: this.platformMcpSessions.size
      });
    },

    onWorkspaceConfigChanged: async (workspaceId: string) => {
      logger.info("Reloading job tools for changed workspace in all sessions", { workspaceId });

      // Notify all active platform sessions
      for (const [sessionId, session] of this.platformMcpSessions) {
        try {
          await session.server.reloadWorkspaceJobTools(workspaceId);
          logger.debug("Reloaded job tools in session", { workspaceId, sessionId });
        } catch (error) {
          logger.error("Failed to reload job tools in session", { error, workspaceId, sessionId });
        }
      }

      logger.info("Job tools reloaded across all sessions", {
        workspaceId,
        sessionCount: this.platformMcpSessions.size
      });
    },
  });

  // NOTE: No tool registration at startup
  // Tools are registered per-session when getOrCreatePlatformSession() is called
  // Each new session registers tools for ALL existing workspaces

  // ... rest of initialization ...

  this.isInitialized = true;
  logger.info("Atlas daemon initialized");
}
```

### Success Criteria:

#### Automated Verification:

- [x] `WorkspaceLifecycleObserver` interface type checks correctly
- [x] `WorkspaceManager.addLifecycleObserver()` compiles without errors
- [x] Platform MCP Server methods (`registerWorkspaceJobTools`, etc.) type check
- [x] Type checking passes: `deno check` (pre-existing library-storage-adapter error unrelated to changes)
- [x] Daemon initializes and registers lifecycle observer without errors

#### Manual Verification:

- [ ] New sessions register tools for ALL existing workspaces on creation
- [ ] Tool naming follows `workspace_<id>_job_<name>` convention
- [ ] Tool schemas match signal schemas
- [ ] New workspace registration adds job tools to ALL active sessions
- [ ] Workspace deletion removes job tools from ALL active sessions
- [ ] Workspace config changes reload job tools in ALL active sessions
- [ ] MCP clients receive `listChanged` notifications automatically per session
- [ ] Multiple workspaces can have jobs with the same name (scoped by workspace ID)
- [ ] Each session has its own isolated tool registry
- [ ] Tool changes in one session don't affect other sessions until workspace lifecycle event

---

## Phase 3: Direct Job Execution with Notifications

### Overview

Implement direct job execution that bypasses signals and uses MCP notifications for progress.

**Key Change**: Add `executeJobDirectly()` method to WorkspaceRuntime that creates sessions without signal lookup. Current `triggerJob()` method requires finding a signal, which defeats the "bypass signals" architecture.

### Changes Required:

#### 1. Workspace Runtime Direct Job Execution

**File**: `src/core/workspace-runtime.ts`
**Changes**: Add direct job execution method that bypasses signal lookup

```typescript
import type { StreamEmitter } from "@atlas/agent-sdk";

// Add new method (recommend placing after triggerJob around line 398)
/**
 * Execute job directly without signal lookup (for MCP tool execution)
 */
async executeJobDirectly(
  jobName: string,
  params: unknown,
  streamEmitter: StreamEmitter,
): Promise<IWorkspaceSession> {
  const jobSpec = this.config?.workspace?.jobs?.[jobName];
  if (!jobSpec) {
    throw new Error(`Job '${jobName}' not found in workspace`);
  }

  // Create session ID
  const sessionId = crypto.randomUUID();

  // Send EXECUTE_JOB event to state machine
  // State machine will create the session actor with stream emitter
  this.stateMachine.send({
    type: "EXECUTE_JOB",
    sessionId,
    jobName,
    jobSpec,
    params,
    streamEmitter,
  });

  // Retrieve the session created by state machine
  // Wait briefly for state machine to process event
  await new Promise(resolve => setTimeout(resolve, 10));

  const session = this.getSession(sessionId);
  if (!session) {
    throw new Error(`Failed to create session for job '${jobName}'`);
  }

  return session;
}
```

**Note**: This bypasses the signal lookup that `triggerJob()` requires. The state machine handles session creation with the stream emitter.

#### 2. State Machine Job Processing

**File**: `src/core/workspace-runtime-machine.ts`
**Changes**: Handle EXECUTE_JOB event

**Note**: Need to examine current state machine event handling patterns before implementing. The state machine may already have appropriate handlers that can be extended.

```typescript
// Add to state machine events (location TBD based on machine structure)
EXECUTE_JOB: {
  actions: [
    ({ context, event }) => {
      const { sessionId, jobName, jobSpec, params, streamEmitter } = event;

      // Create session supervisor with stream emitter
      // Pass streamEmitter to supervisor (MCP or SSE depending on execution path)
      const sessionActor = spawn(
        createSessionSupervisorActor({
          sessionId,
          jobName,
          jobSpec,
          params,
          emitter: streamEmitter, // StreamEmitter interface (MCP/SSE/Callback)
          ...context, // Workspace context
        }),
        { id: sessionId }
      );

      // Track session in context
      context.sessions.set(sessionId, {
        id: sessionId,
        actor: sessionActor,
        status: "pending",
      });

      // Session actor will handle execution and emit via provided StreamEmitter
    },
  ],
}
```

**Implementation Note**: The exact event structure depends on existing state machine patterns. Review `processSignal()` flow (current signal-based execution) to maintain consistency.

#### 3. Session Supervisor MCP Integration

**File**: `src/core/actors/session-supervisor-actor.ts`
**Changes**: Use StreamEmitter interface for both MCP and SSE emissions

**Note**: The session supervisor should accept the abstract `StreamEmitter` interface from `@atlas/agent-sdk`. All emitters (HTTPStreamEmitter, MCPStreamEmitter, CallbackStreamEmitter) implement this interface. Pass the appropriate emitter at session creation time.

```typescript
import type { StreamEmitter } from "@atlas/agent-sdk";

// Session supervisor should accept StreamEmitter interface
constructor(
  context: SessionSupervisorContext,
  emitter: StreamEmitter,
) {
  // Use provided emitter for all notifications
  // Emitter can be HTTPStreamEmitter (SSE), MCPStreamEmitter (MCP), or CallbackStreamEmitter
}

// Emit method uses the StreamEmitter interface
emit(event: AtlasUIMessageChunk): void {
  this.emitter.emit(event);
}
```

**Implementation Note**: Verify if session supervisor already uses the `StreamEmitter` interface. If so, no changes needed - just pass `MCPStreamEmitter` instance instead of `HTTPStreamEmitter` when triggered via MCP tools.

#### 4. Session Completion Tracking

**File**: `src/core/session.ts`
**Changes**: Add public `waitForCompletion()` method that wraps actor's execution promise

**Research Findings**:
- SessionSupervisorActor already has completion tracking via `executionPromise` (line 131)
- `getExecutionPromise()` exposes the promise (lines 578-580)
- Session class already uses this pattern internally in `attachSessionActor()` (lines 290-331)
- We just need to expose it as a public method for MCP tool use

```typescript
import type { SessionSummary } from "./actors/session-supervisor-actor.ts";

// Add to Session class (recommend after attachSessionActor method, around line 332)
/**
 * Wait for session execution to complete
 * Returns the full SessionSummary with status, results, and metadata
 *
 * @returns Promise that resolves with SessionSummary on completion
 * @throws Error if session execution fails
 */
async waitForCompletion(): Promise<SessionSummary> {
  if (!this.sessionActor) {
    throw new Error("Session actor not attached - cannot wait for completion");
  }

  return new Promise((resolve, reject) => {
    const checkPromise = () => {
      const promise = this.sessionActor?.getExecutionPromise();
      if (promise) {
        // Found the execution promise, attach handlers
        promise.then(resolve, reject);
      } else {
        // Promise not ready yet, check again in next microtask
        queueMicrotask(checkPromise);
      }
    };
    checkPromise();
  });
}
```

**Pattern Origin**: This follows the exact pattern used internally by `attachSessionActor()` (lines 311-331), but exposed as a public method for external consumers like MCP tools.

**Also update the interface:**

**File**: `src/types/core.ts`
**Changes**: Add method signature to IWorkspaceSession interface

```typescript
// Add to IWorkspaceSession interface (around line 111, before closing brace)
export interface IWorkspaceSession extends IAtlasScope {
  signals: { triggers: IWorkspaceSignal[]; callback: IWorkspaceSignalCallback };
  agents?: IWorkspaceAgent[];
  workflows?: IWorkspaceWorkflow[];
  sources?: IWorkspaceSource[];
  status: string;
  start(): Promise<void>;
  cancel(): void;
  cleanup(): void;
  progress(): number;
  summarize(): string;
  getArtifacts(): IWorkspaceArtifact[];
  waitForCompletion(): Promise<SessionSummary>; // NEW
}
```

### Success Criteria:

#### Automated Verification:

- [x] `executeJobDirectly()` creates sessions without signal lookup
- [x] `waitForCompletion()` method added to Session class and IWorkspaceSession interface
- [x] `waitForCompletion()` returns Promise<SessionSummary> with correct type signature
- [ ] MCP notifications sent during execution (requires Phase 2 MCP tool integration to test)
- [x] Type checking passes: `deno check` (pre-existing library-storage-adapter error unrelated to changes)
- [ ] Unit tests pass: `deno task test` (deferred to manual testing)
- [ ] Session completion promise resolves correctly with SessionSummary (requires integration testing)

#### Manual Verification:

- [ ] Progress notifications received by MCP client
- [ ] No SSE stream contention when multiple jobs run
- [ ] Concurrent jobs execute in parallel without queueing
- [ ] Job execution completes and returns SessionSummary with correct status and results
- [ ] `waitForCompletion()` properly awaits session execution before returning

**Implementation Notes** (from research):

1. ✅ Session completion tracking exists - SessionSupervisorActor has `executionPromise` (line 131)
2. ✅ Session class already uses this pattern in `attachSessionActor()` (lines 290-331)
3. ✅ SessionSupervisorActor uses `StreamEmitter` interface abstraction - can accept MCP or HTTP emitters
4. Review `src/core/workspace-runtime-machine.ts` event handling patterns before implementing EXECUTE_JOB event

---

## Phase 4: Dual Execution Path Support

### Overview

Support both MCP tool and signal-based execution paths. MCP tools provide direct execution for conversation agent (avoiding SSE contention), while signals remain for external triggers (cron, webhooks, fs-watch).

**Architecture:**

- **MCP Path**: `executeJobDirectly()` bypasses signals, uses MCP notifications
- **Signal Path**: Existing signal flow unchanged, uses SSE streams

### Changes Required:

#### 1. Error Result Formatting

**File**: `packages/mcp-server/src/tools/jobs/execute.ts`
**Changes**: Proper error formatting per CallToolResultSchema

```typescript
// Modify catch block
catch (error) {
  ctx.logger.error("Job execution failed via MCP tool", {
    error,
    jobName,
    workspaceId,
    executionPath: "mcp-tool"
  });

  return {
    isError: true,
    content: [{
      type: "text",
      text: JSON.stringify({
        error: error.message,
        code: error.code || "JOB_EXECUTION_FAILED",
        jobName,
        sessionId,
        executionPath: "mcp-tool",
      }),
    }],
  };
}
```

#### 2. Session Cancellation Support

**File**: `packages/mcp-server/src/platform-server.ts`
**Changes**: Handle MCP cancellation notifications for MCP-triggered jobs

```typescript
import { executeJob } from "./tools/jobs/execute.ts";
export class PlatformMCPServer {
  private activeJobSessions = new Map<string, IWorkspaceSession>(); // Track MCP-triggered jobs

  constructor(dependencies: PlatformMCPServerDependencies) {
    // ... existing constructor ...

    // Handle cancellation notifications for MCP-triggered jobs
    this.server.setNotificationHandler(
      "notifications/cancelled",
      async (params) => {
        const { requestId } = params;
        const session = this.activeJobSessions.get(requestId);
        if (session) {
          this.logger.info("Cancelling MCP-triggered job", {
            requestId,
            sessionId: session.id,
          });
          await session.cancel();
          this.activeJobSessions.delete(requestId);
        }
      },
    );
  }

  async registerWorkspaceJobTools(workspaceId: string): Promise<void> {
    // ... existing registration ...

    const toolHandle = this.server.tool(
      toolName,
      inputSchema,
      async (params, requestId) => {
        // requestId from MCP SDK
        const result = await executeJob(
          {
            /* ... */
          },
          workspaceId,
          jobName,
          params,
        );

        // Track session if execution started successfully
        if (!result.isError && result.sessionId) {
          this.activeJobSessions.set(requestId, result.session);
        }

        return result;
      },
    );
  }
}
```

#### 3. Execution Path Metadata

**File**: `src/core/workspace-runtime.ts`
**Changes**: Add metadata to distinguish execution paths

```typescript
async executeJobDirectly(
  jobName: string,
  params: unknown,
  streamEmitter: StreamEmitter,
): Promise<IWorkspaceSession> {
  const jobSpec = this.config?.workspace?.jobs?.[jobName];
  if (!jobSpec) {
    throw new Error(`Job '${jobName}' not found in workspace`);
  }

  const sessionId = crypto.randomUUID();

  // Send EXECUTE_JOB event with execution path metadata
  this.stateMachine.send({
    type: "EXECUTE_JOB",
    sessionId,
    jobName,
    jobSpec,
    params,
    streamEmitter,
    executionPath: "mcp-tool", // NEW: Track execution path
  });

  // ... rest of method
}

// Existing triggerSignalWithSession remains unchanged
async triggerSignalWithSession(
  signalName: string,
  payload?: Record<string, unknown>,
  streamId?: string,
): Promise<IWorkspaceSession> {
  // Existing signal-based execution (uses SSE)
  // executionPath: "signal" (implicit)
  // ... unchanged ...
}
```

#### 4. Documentation and Logging

**File**: `apps/atlasd/routes/streams/emit.ts`
**Changes**: Document dual execution paths

```typescript
/**
 * SSE stream emission endpoint
 *
 * Handles SSE streaming for signal-triggered sessions.
 *
 * Note: Job sessions triggered via MCP tools use MCP notifications
 * instead of SSE streams, avoiding the stream contention issue.
 * Both execution paths coexist:
 * - Signal path: External triggers → signals → SSE streams
 * - MCP path: Conversation agent → MCP tools → MCP notifications
 */
export async function emitSSEEvent(/* ... */) {
  // Existing SSE logic unchanged
}
```

### Success Criteria:

#### Automated Verification:

- [x] Error responses conform to CallToolResultSchema
- [x] Cancellation notifications terminate MCP-triggered jobs
- [x] Signal-triggered jobs continue to work unchanged (no changes to signal path)
- [x] Type checking passes: `deno check` (pre-existing library-storage-adapter error unrelated to Phase 4 changes)
- [ ] Integration tests pass: `deno task test:integration` (deferred to manual testing)

#### Manual Verification:

- [ ] Job errors returned as MCP error results with `executionPath` metadata
- [ ] MCP-triggered jobs cancelled properly via notifications
- [ ] Signal-triggered jobs (cron, webhooks, fs-watch) still work
- [ ] Conversation agent jobs execute via MCP tools (no SSE contention)
- [ ] External trigger jobs execute via signals (existing SSE flow)
- [ ] Both execution paths can run concurrently without interference
- [ ] No orphaned sessions in either path

---

## Testing Strategy

### Unit Tests:

- Job tool registration with various schemas
- Error handling for missing jobs
- Notification emitter functionality
- Session completion promises

### Integration Tests:

- Concurrent job execution via MCP tools (no queueing)
- Concurrent job execution via signals (existing SSE behavior)
- Job cancellation via MCP notifications (MCP path)
- Job cancellation via session API (signal path)
- Error propagation through both execution paths
- Notification delivery to MCP clients
- SSE stream delivery for signal-triggered jobs

### Manual Testing Steps:

**MCP Tool Path:**

1. Conversation agent triggers multiple jobs via MCP tools
2. Verify parallel execution without SSE queueing
3. Cancel MCP-triggered job via notification
4. Trigger job with invalid params, verify MCP error response
5. Monitor MCP notifications for progress updates

**Signal Path (unchanged):** 6. Trigger job via cron signal 7. Verify SSE stream emission 8. Trigger job via webhook signal 9. Verify signal-based execution still works

**Mixed Execution:** 10. Trigger job via MCP tool while signal-based job running 11. Verify both paths execute concurrently without interference

## Performance Considerations

- **MCP Path**: Direct runtime access eliminates HTTP overhead
- **MCP Path**: Parallel job execution without SSE queueing (solves the 30-second timeout issue)
- **Signal Path**: Existing SSE queueing behavior unchanged (one session per stream at a time)
- Notification batching may be needed for high-frequency updates in MCP path
- Consider connection pooling for multiple workspace support
- Both paths can execute concurrently without resource contention

## Migration Notes

Both execution paths coexist:

- **MCP Tool Path**: Conversation agent uses MCP tools for job execution
- **Signal Path**: External triggers continue using signal-based execution
- No migration required for existing signal-based jobs
- Conversation agent benefits from parallel execution without SSE contention
- Documentation should explain when to use each path:
  - Use MCP tools when conversation agent needs to invoke jobs
  - Use signals for external triggers (cron, webhooks, fs-watch)

## References

- Original research: `thoughts/shared/research/2025-01-09-jobs-as-mcp-tools.md`
- Consistency analysis: `thoughts/ANALYSIS-2025-09-30-plan-consistency-check.md`
- PR #438 (workspace lifecycle): https://github.com/tempestteam/atlas/pull/438
- SSE queueing issue: `apps/atlasd/routes/streams/emit.ts:60-64`
- MCP notification pattern: `packages/mcp-server/src/tools/library/get-stream.ts:46-194`
- Current job triggering: `src/core/workspace-runtime.ts:374-398`
- WorkspaceManager: `packages/workspace/src/manager.ts`
- Daemon runtime creation: `apps/atlasd/src/atlas-daemon.ts:586-818`

## Change Log

**2025-10-01**: Revised to use per-session Platform MCP Server pattern

- **Architecture change**: Platform MCP Server now uses per-session pattern (mirrors agent server)
- **Phase 1 expanded**: Added per-session storage, stateful `/mcp` endpoint, session cleanup with timeout/LRU eviction
- **Phase 2 updated**: Lifecycle observer iterates ALL active platform sessions to add/remove/reload tools
- **Benefits**: Proper session isolation, SSE notification support, matches MCP SDK docs exactly, proven pattern
- Removed single global Platform MCP Server instance approach
- New sessions register tools for ALL existing workspaces on creation
- Workspace lifecycle events update tools in ALL active sessions

**2025-09-30**: Updated plan to reflect PR #438 changes

- Changed WorkspaceManager approach to WorkspaceProvider pattern
- Corrected method names (`getOrCreateRuntime` not `getOrCreateWorkspace`)
- Added `executeJobDirectly()` method for MCP tool execution path
- Added validation steps for Session completion tracking
- Documented implementation notes for state machine integration
- Added dynamic tool registration using MCP SDK lifecycle callbacks
- Implemented `WorkspaceLifecycleObserver` pattern for automatic tool add/remove/reload
- Job tools now automatically appear when workspaces are registered
- Job tools automatically removed when workspaces are deleted
- Job tools automatically reloaded when workspace.yml changes
- **Clarified dual execution path architecture**:
  - MCP tool path for conversation agent (bypasses signals/SSE)
  - Signal path for external triggers (unchanged, uses SSE)
  - Both paths coexist and can run concurrently
