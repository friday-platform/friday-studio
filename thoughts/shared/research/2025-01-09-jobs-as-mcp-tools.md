---
date: 2025-09-25T09:29:13-06:00
researcher: ericskram
git_commit: 53c81f52ee71582ea69b8af446b03f33fc4e5d81
branch: jobs-as-tools
repository: jobs-as-tools
topic: "Exposing Atlas workspace jobs as MCP tools to solve SSE stream interleaving"
tags:
  [
    research,
    codebase,
    mcp,
    jobs,
    signals,
    sse-streaming,
    workspace-runtime,
    session-supervisor,
  ]
status: complete
last_updated: 2025-01-09
last_updated_by: ericskram
last_updated_note: "Added follow-up research clarifying MCP handle attachment to signal-triggered sessions"
---

# Research: Exposing Atlas Workspace Jobs as MCP Tools

**Date**: 2025-09-25T09:29:13-06:00
**Researcher**: ericskram
**Git Commit**: 53c81f52ee71582ea69b8af446b03f33fc4e5d81
**Branch**: jobs-as-tools
**Repository**: jobs-as-tools

## Research Question

Atlas workspaces have jobs that are triggered via signals. The conversation agent can trigger these through an MCP tool, but when multiple jobs are triggered concurrently, their SSE stream outputs interleave causing problems. Can workspace jobs be exposed directly as MCP tools, using MCP notifications for progress reporting to give the conversation agent a single handle for job execution and progress monitoring?

## Summary

The current Atlas architecture triggers jobs through signals, creating independent sessions that all attempt to stream to the same SSE channel. This causes session queueing and potential 30-second timeouts. By exposing jobs as MCP tools and attaching an MCP notification handle to the signal-triggered session, we can give the conversation agent a dedicated channel for progress updates without interfering with the SSE stream. The solution involves dynamic tool registration in the WorkspaceMCPServer, attaching MCP notification handles to sessions, and dual-channel progress reporting (MCP notifications + optional SSE).

## Detailed Findings

### Current Job Triggering Architecture

#### Signal-Based Job Triggering

- Jobs defined in workspace.yml (`examples/telephone/workspace.yml:55-88`)
- Triggered via signals with JsonLogic conditions
- MCP tool `atlas_signal_trigger` sends HTTP request (`packages/mcp-server/src/tools/signals/trigger.ts:13-61`)
- Daemon routes to workspace runtime (`apps/atlasd/routes/signals/trigger.ts:47-119`)
- Runtime creates session via state machine (`src/core/workspace-runtime.ts:203`)
- Session executes asynchronously without blocking

#### SSE Stream Management Problem

- Session events queue per streamId (`apps/atlasd/routes/streams/emit.ts:43-57`)
- Only one session active per stream at a time (`apps/atlasd/routes/streams/emit.ts:61`)
- Sessions must emit `data-session-finish` to rotate (`apps/atlasd/routes/streams/emit.ts:151-157`)
- Missing finish events cause 30-second timeout (`apps/atlasd/routes/streams/emit.ts:159-177`)
- Concurrent jobs queue sequentially, causing delays

### MCP Server Implementation

#### Tool Registration System

- Static tool registration at server initialization (`packages/mcp-server/src/platform-server.ts:39-54`)
- Tools registered via modular pattern (`packages/mcp-server/src/tools/index.ts:48-94`)
- WorkspaceMCPServer already supports job tools (`packages/mcp-server/src/workspace-server.ts:107-129`)
- Jobs exposed when listed in `discoverable.jobs` config

#### Current Job Tool Implementation

- Jobs registered as individual tools at startup (`packages/mcp-server/src/workspace-server.ts:107-129`)
- Tool invocation calls `workspaceRuntime.triggerJob()` (`packages/mcp-server/src/workspace-server.ts:194-222`)
- Returns only session ID, no progress mechanism

### MCP Notification Protocol Capabilities

#### Notification Methods Available

- `notifications/message` - General logging/status messages
- `notifications/tool/streamContent` - Tool-specific content streaming
- `notifications/cancelled` - Cancellation signals

#### Existing Streaming Patterns

- Library streaming example (`packages/mcp-server/src/tools/library/get-stream.ts:46-194`)
  - Start notification with metadata
  - Progress notifications with chunk info
  - Completion notification with summary
  - Silent mode for high-frequency updates

#### Stream Emitter Infrastructure

- MCPStreamEmitter exists (`packages/core/src/streaming/stream-emitters.ts:109-149`)
- Uses `notifications/tool/streamContent` method
- Includes toolName and sessionId for correlation

### Proposed Architecture Changes

#### Dynamic Job Tool Registration

- Modify WorkspaceMCPServer to dynamically register jobs as tools
- Tool naming convention: `workspace_<workspaceId>_job_<jobName>`
- Input schema derived from signal's schema property (JSON Schema)
- Descriptions from job configuration

#### MCP Handle Attachment to Sessions

- Keep existing signal triggering flow
- When triggered via MCP tool, attach notification handle to session
- Session receives EITHER streamId (for SSE) OR MCP notification emitter
- Single emitter per session - inject the correct one based on trigger source

#### MCP Notification-Based Progress

- Session supervisor uses single emitter injected at creation
- MCP channel: Session → MCP Notifications → Conversation Agent
- SSE channel: Session → SSE Stream (traditional flow)
- Conversation agent receives dedicated notification channel when using MCP
- Clean separation - one session, one emitter

## Code References

- `examples/telephone/workspace.yml:55-88` - Job definition structure
- `packages/mcp-server/src/workspace-server.ts:107-129` - Existing job tool registration
- `apps/atlasd/routes/streams/emit.ts:43-57` - SSE session queueing problem
- `packages/mcp-server/src/tools/library/get-stream.ts:46-194` - MCP notification streaming pattern
- `packages/core/src/streaming/stream-emitters.ts:109-149` - MCPStreamEmitter implementation
- `src/core/workspace-runtime.ts:374-398` - Current triggerJob implementation
- `src/core/actors/session-supervisor-actor.ts:1273-1276` - Agent progress events
- `packages/config/src/signals.ts:14` - Signal schema property for JSON Schema validation
- `packages/config/src/signals.ts:95-103` - SignalTriggerRequestSchema with payload and streamId

## Architecture Documentation

### Current Patterns

- **Actor-Based Sessions**: Sessions are XState actors managed by state machine
- **Signal-Job Mapping**: Jobs triggered by signals with JsonLogic conditions
- **SSE Stream Queueing**: Sequential session processing per stream
- **Static Tool Registration**: Tools registered once at server startup

### Revised Implementation Pattern

```typescript
// Phase 1: Dynamic job tool registration
this.server.registerTool({
  name: `workspace_${workspaceId}_job_${jobName}`,
  description: jobSpec.description,
  inputSchema: signalConfig.schema, // Use signal's JSON Schema
  handler: async (params) => this.executeJobViaMCP(jobName, params)
});

// Phase 2: Trigger signal with MCP handle
async executeJobViaMCP(jobName: string, params: unknown) {
  // Create MCP notification emitter
  const mcpEmitter = new MCPNotificationEmitter(
    this.server,
    `workspace_${workspaceId}_job_${jobName}`,
    sessionId
  );

  // Trigger signal but attach MCP handle to session
  const session = await workspaceRuntime.triggerJobWithMCPHandle(
    jobName,
    params,
    mcpEmitter  // Additional parameter for MCP notifications
  );

  // Wait for completion while receiving progress via notifications
  return await session.waitForCompletion();
}

// Phase 3: Single emitter injection in session
class SessionSupervisorActor {
  constructor(private emitter: EventEmitter) {
    // Session receives appropriate emitter at creation
    // Either SSE emitter OR MCP emitter, not both
  }

  emit(event: SessionUIMessageChunk) {
    // Simple - emit to the single injected emitter
    this.emitter.emit(event);
  }
}

// Phase 4: Handle cancellation
server.setNotificationHandler('notifications/cancelled', (notification) => {
  if (notification.params.requestId === currentToolCallId) {
    session.cancel();
  }
});
```

### Benefits of New Architecture

1. **Single Control Point**: Conversation agent orchestrates all job execution
2. **No SSE Interleaving**: Agent remains sole SSE writer
3. **Synchronous Execution**: Tool calls can await job completion
4. **Real-Time Progress**: Notifications provide immediate feedback
5. **Backward Compatible**: Existing signal flow remains functional
6. **Simple Implementation**: One session, one emitter (80/20 principle)

## Related Research

None currently in thoughts/shared/research/

## Follow-up Research [2025-01-09]

### Clarified Architecture: MCP Handle Attachment

After further discussion, the architecture has been refined. Rather than bypassing signals, we will:

1. **Keep the signal triggering flow** - Jobs are still triggered via signals
2. **Attach MCP notification handle** - When triggered via MCP tool, attach a notification emitter to the session
3. **Single emitter per session** - Sessions receive EITHER SSE emitter OR MCP emitter, not both (80/20 principle)
4. **Conversation agent as orchestrator** - Agent receives MCP notifications and controls SSE output

This approach maintains backward compatibility while solving the SSE interleaving problem.

### Answers to Open Questions

1. **Dynamic registration**: Yes, tools should be registered dynamically when workspaces are created
2. **Input schemas**: Use the signal's `schema` property (JSON Schema), not JsonLogic conditions
3. **Batching**: Start simple, no batching needed initially (YAGNI principle)
4. **Cancellation**: MCP protocol has built-in `notifications/cancelled` that needs to be wired to session cancellation
5. **Namespacing**: Use `workspace_<id>_job_<name>` convention
6. **Authentication**: Jobs aren't authenticated currently, ignore for now

### Key Implementation Details

- **Signal Schema**: Signals have a `schema` property (`packages/config/src/signals.ts:14`) that defines the JSON Schema for payload validation - this becomes the tool's input schema
- **MCP Cancellation**: The MCP client can send `notifications/cancelled` with a requestId to terminate tool execution
- **Session Handle**: The core need is to attach an MCP handle to the job session initiated by the signal, not to bypass signals entirely

## Implementation Architecture [2025-01-09]

### MCP Notification Flow Architecture

After deeper research, the notification flow from sessions back to the conversation agent works as follows:

#### Current Agent Server Pattern

- Conversation agent creates MCP client connection (`conversation.agent.ts:92`)
- Sets notification handler for `StreamContentNotificationSchema` (`conversation.agent.ts:141`)
- Agent server sends notifications via `server.notification()`
- Notifications flow: Agent → Agent Server → Conversation Agent

#### Proposed Job Tool Pattern

- Conversation agent calls job tool on Platform MCP Server
- Platform MCP Server (as server) needs to send notifications back to conversation agent (as client)
- Create MCPNotificationEmitter that wraps `server.notification()`
- Pass emitter through signal flow to session
- Notifications flow: Session → Platform MCP Server → Conversation Agent

### Key Implementation Details

#### 1. Notification Emitter Creation

```typescript
// In Platform MCP Server job tool handler
const notificationEmitter = new MCPNotificationEmitter(
  ctx.server, // MCP server instance from ToolContext
  `workspace_${workspaceId}_job_${jobName}`,
  sessionId,
);
```

#### 2. Signal Extension

- Extend `SignalTriggerRequest` to optionally accept `notificationEmitter`
- Pass through signal processing chain to session supervisor
- Session uses provided emitter (MCP) OR creates default SSE emitter

#### 3. Session Completion Synchronization

- Job tool creates Promise that resolves on session completion
- Session sends completion notification via MCP
- Tool awaits Promise before returning result

#### 4. Cancellation Correlation

- Use requestId from MCP tool invocation
- Track sessionId → requestId mapping
- On `notifications/cancelled`, find session by requestId and cancel

### Answers to Implementation Questions

1. **MCP Notification Emitter Passing**: Create emitter in Platform MCP Server tool handler using `ctx.server`, pass through signal trigger request as additional parameter
2. **Channel Selection**: Single emitter pattern - session gets MCP emitter when triggered via MCP, SSE emitter when triggered via HTTP
3. **Session Completion**: Tool creates completion Promise, session sends finish notification, tool awaits Promise resolution
4. **Cancellation Correlation**: Track requestId → sessionId mapping in Platform MCP Server, handle `notifications/cancelled`
5. **Tool Registration**: Register ALL jobs as tools initially for maximum flexibility

## Architectural Decision: Platform MCP Server as Peer Interface [2025-01-09]

### The Architectural Shift

After analysis, the Platform MCP Server should be reconsidered as a **peer interface** to the daemon, not a client of it:

- **Current Model**: Platform MCP Server → HTTP → Daemon → Runtime (problematic)
- **Revised Model**: Platform MCP Server → Runtime (direct access, clean)

Both the daemon HTTP API and Platform MCP Server are first-class network interfaces to the Atlas runtime, using different protocols for different audiences:

- **Daemon HTTP**: RESTful API for web clients, CLI, general integration
- **Platform MCP**: Model Context Protocol for AI agents and LLM tools

### Implementation with Direct Runtime Access

```typescript
// Platform MCP Server with direct runtime access
class PlatformMCPServer {
  private workspaceManager: WorkspaceManager; // Direct reference

  async executeJobTool(jobName: string, params: unknown) {
    const runtime = await this.workspaceManager.getRuntime(workspaceId);

    // Direct notification callback - no HTTP boundary!
    const notifier = (event) => {
      this.server.notification({
        method: "notifications/tool/streamContent",
        params: { toolName, sessionId, event },
      });
    };

    // Pass notifier directly to session
    const session = await runtime.triggerJobWithNotifier(
      jobName,
      params,
      notifier, // Direct function reference
    );

    return await session.waitForCompletion();
  }
}
```

### Benefits

1. **No serialization complexity** - Direct object/function references
2. **Natural bidirectional communication** - Callbacks and notifications work naturally
3. **Cleaner architecture** - Protocol differences don't dictate service boundaries
4. **Better performance** - No HTTP overhead for streaming

### Principles

- Service boundaries reflect business logic, not protocol differences
- Multiple protocols can expose the same service layer
- Direct runtime access where necessary, HTTP where convenient

## Implementation Details [2025-01-09]

### Resolved Questions and Implementation Path

#### 1. How should the Platform MCP Server and daemon share runtime instances?

**Answer: Dependency Injection**

The daemon already creates the Platform MCP Server at `apps/atlasd/src/atlas-daemon.ts:211-215`:

```typescript
// Current
this.mcpServer = new PlatformMCPServer({
  daemonUrl,
  logger: logger.child({ component: "platform-mcp-server" }),
});
```

Should become:

```typescript
// With direct runtime access
this.mcpServer = new PlatformMCPServer({
  daemonUrl, // Keep for backward compatibility
  logger: logger.child({ component: "platform-mcp-server" }),
  workspaceProvider: {
    getOrCreateRuntime: (id: string) => this.getOrCreateWorkspaceRuntime(id),
  },
});
```

#### 2. Should they run in the same process or as closely-coupled services?

**Answer: Same Process (Already the case)**

They already run in the same process - the daemon spawns the Platform MCP Server. This enables:

- Direct object references without serialization
- Function pointers for notification callbacks
- Shared memory for runtime instances
- Zero overhead for streaming

#### 3. What's the migration path from current HTTP-client model to peer model?

**Answer: Optional Runtime Provider with HTTP Fallback**

Minimal migration - just add optional runtime provider to constructor:

```typescript
class PlatformMCPServer {
  constructor(options: {
    daemonUrl: string;
    logger: Logger;
    workspaceProvider?: WorkspaceProvider; // New optional field
  }) {
    // Use workspaceProvider if available, otherwise HTTP client
  }
}
```

The migration is literally just passing dependencies instead of discovering them via HTTP.

#### 4. How do we ensure consistency between the two interfaces?

**Answer: Pragmatic Tool-by-Tool Approach**

Not a concern - each tool uses the appropriate approach:

- **Simple request/response tools**: Continue using HTTP endpoints
- **Streaming/notification tools (jobs)**: Use direct runtime access
- Both respect the same business logic boundaries
- "Pick the right tool for the job"
