# Conversations as Workspaces

## Overview

This document outlines the design for implementing Atlas conversations as a system workspace,
allowing conversations to be built using Atlas's own workspace/job/agent architecture.

## Problem Statement

Currently, conversations are handled by a separate ConversationSupervisor system that exists outside
the Atlas workspace paradigm. This creates:

- Duplicate architecture patterns
- Separate storage and state management
- Limited ability to leverage Atlas features within conversations

## Solution: System Workspaces

Implement conversations as a special "system workspace" that:

- Uses Atlas's existing signal/job/agent architecture
- Provides conversation-specific features (streaming, storage)
- Maintains proper scope isolation between workspace contexts

## Architecture

### Building on Existing Components

This design extends existing Atlas components rather than replacing them:

- **ConversationSupervisor**: Already provides streaming conversation events
- **ConversationSessionManager**: Manages sessions, needs KV storage upgrade
- **ConversationSupervisorAgent**: Full Atlas agent, needs scope awareness
- **KVStorage**: Existing abstraction with Deno implementation ready
- **Session**: Core session class, needs optional I/O channels
- **SSE Infrastructure**: Existing streaming utilities for response delivery

### 1. System Workspace Declaration

Extend `atlas.yml` to support system workspaces:

```yaml
# atlas.yml
system_workspaces:
  conversation:
    enabled: true
    workspace_path: "@atlas/system/conversation"
    config:
      default_model: "claude-3-5-sonnet-20241022"
```

### 2. Conversation Scoping

Conversations operate at four scope levels:

1. **Global** - Atlas-wide conversation (atlas-global workspace)
2. **Workspace** - Workspace-specific conversation with isolated context
3. **Job** - Conversation within a specific job context
4. **Session** - Conversation within a specific session

Each scope:

- Inherits read access from parent scopes
- Has isolated write access to its own state
- Can access appropriate tools based on scope

### 3. Storage Architecture

Conversations require deterministic storage (not the lossy memory system):

- **Internal KV Store** - Private to conversation system workspace
- **Agent implementation managed** - Storage handled in agent code, not LLM tool calls
- **Scope-partitioned** - Automatic isolation by conversation scope

### 4. Key Differences from Normal Workspaces

System workspaces have special capabilities:

- **Streaming responses** - Return SSE streams instead of fire-and-forget
- **Internal storage** - Access to private KV adapters
- **Dynamic tool registration** - Tools change based on conversation scope
- **Bypass validation** - System workspaces have special privileges

### 5. Implementation Architecture

System workspaces integrate with AtlasDaemon to provide conversation endpoints:

```typescript
// AtlasDaemon initializes system workspaces
class AtlasDaemon {
  private systemWorkspaces: Map<string, SystemWorkspace> = new Map();
  private activeChannels: Map<string, ResponseChannel> = new Map();

  async initializeSystemWorkspaces() {
    if (config.system_workspaces?.conversation?.enabled) {
      const conversationWorkspace = new ConversationSystemWorkspace();
      await conversationWorkspace.initialize();
      this.systemWorkspaces.set("conversation", conversationWorkspace);

      // System workspaces register special routes
      this.setupSystemWorkspaceRoutes("conversation", conversationWorkspace);
    }
  }

  private setupSystemWorkspaceRoutes(workspaceName: string, workspace: SystemWorkspace) {
    // System workspace streaming endpoint
    // Materialized path: /system/conversation/stream
    this.app.post(`/system/${workspaceName}/stream`, async (c) => {
      const payload = await c.req.json();

      // Create response channel for streaming
      const sessionId = generateId();
      const channel = new StreamingResponseChannel();
      this.activeChannels.set(sessionId, channel);

      // Trigger signal with response channel
      await workspace.triggerSignal(`${workspaceName}-stream`, payload, channel);

      // Return SSE endpoint URL immediately
      return c.json({
        success: true,
        session_id: sessionId,
        response_channel: {
          type: "sse",
          url: `/system/${workspaceName}/sessions/${sessionId}/stream`,
        },
      });
    });

    // SSE endpoint for streaming responses
    // Materialized path: /system/conversation/sessions/:sessionId/stream
    this.app.get(`/system/${workspaceName}/sessions/:sessionId/stream`, (c) => {
      const channel = this.activeChannels.get(c.req.param("sessionId"));
      if (!channel) return c.notFound();

      return streamSSE(c, async function* () {
        for await (const event of channel.stream) {
          yield event;
        }
      });
    });
  }
}
```

The conversation system workspace handles different scopes through the signal payload, eliminating
the need for separate conversation management infrastructure.

```typescript
// Client API for conversations
// Endpoint: POST /system/conversation/stream
{
  "message": "Hello Atlas",
  "userId": "cli-user",
  "scope": {
    "workspaceId": "my-workspace",  // optional - workspace context
    "jobId": "analysis-job",         // optional - job context
    "sessionId": "sess-123"          // optional - session context
  }
}
```

Scope determines conversation context:

- Empty scope → Global conversation
- Just `workspaceId` → Workspace-specific conversation
- `workspaceId` + `jobId` → Job-specific conversation
- All three → Session-specific conversation

## Implementation Plan

### Files to Modify

1. **Schema Changes**:
   - `/packages/config/src/schemas.ts` - Add response config to TriggerSpecificationSchema

2. **Core Session/Supervisor**:
   - `/src/core/session.ts` - Add SessionIOChannel and response methods
   - `/src/core/session-supervisor.ts` - Pass response config to sessions
   - `/src/core/supervisor.ts` - Handle response channels when creating sessions

3. **Conversation Components**:
   - `/src/core/conversation-session-manager.ts` - Switch from Map to KVStorage
   - `/src/core/agents/conversation-supervisor-agent.ts` - Add scope awareness

4. **Daemon Changes**:
   - `/apps/atlasd/src/atlas-daemon.ts` - Add system workspace support
   - `/packages/config/src/schemas.ts` - Add system_workspaces to AtlasConfigSchema

5. **New Files**:
   - `/packages/system/conversation/workspace.yml` - System workspace definition
   - `/src/core/system-workspace.ts` - Base class for system workspaces

### Phase 1: Core Infrastructure

1. Add system workspace support to AtlasDaemon
2. Implement ConversationSystemWorkspace class
3. Update ConversationSessionManager to use KVStorage instead of in-memory Maps
4. Extend base Session class with response channel support:
   - Add optional `SessionIOChannel` for response handling
   - Add `stream()` and `respond()` methods
   - Update lifecycle methods to properly close channels
   - No breaking changes - just optional parameters

### Phase 2: Conversation Features

1. Connect existing ConversationSupervisor streaming to response channels
2. Update conversation agents:
   - Extend existing `ConversationSupervisorAgent` for scope-aware context
   - Add `conversation-query` agent for listing past conversations
   - Add `conversation-loader` agent for conversation resumption
3. Add scope management to existing ConversationSessionManager
4. Implement conversation history and resume functionality:
   - Extend ConversationSessionManager with KV-backed persistence
   - Add conversation listing and filtering by scope
   - Storage schema for conversation records

### Phase 3: Integration

1. Update CLI interactive mode to use new system
2. Migrate existing conversation endpoints
3. Remove legacy ConversationSupervisor

## Technical Considerations

### Response Channels - Enabling Request/Response Patterns

The key innovation enabling conversations is **response channels** - an optional extension to the
trigger system that fundamentally enables request/response patterns in Atlas.

#### Response Configuration

Jobs declare response handling per trigger:

```yaml
jobs:
  conversation-handler:
    triggers:
      - signal: "conversation-request"
        response:
          mode: "streaming" # or "unary" or "interactive"
          format: "sse"
          timeout: 300000
```

#### Response Modes

1. **Fire-and-forget** (default) - Traditional Atlas behavior, no response channel
2. **Unary** - Single request/response, daemon waits for completion
3. **Streaming** - Server-sent events for progressive responses
4. **Interactive** - Bidirectional communication for conversations

#### Session I/O Channels

When a trigger has response configuration AND the signal provides a response channel, the session
receives an I/O channel. This requires evolving the base Session class:

```typescript
// New interfaces for response handling
export interface ResponseChannel {
  id: string;
  type: "sse" | "websocket" | "http";
  url: string;
  close: (reason?: string) => Promise<void>;
}

export interface SessionIOChannel {
  mode: "unary" | "streaming" | "interactive";
  format: string;
  input?: ReadableStream;
  output?: WritableStream;
  responseChannel: ResponseChannel;
  close(reason: "complete" | "error" | "timeout" | "client"): Promise<void>;
}

// Evolution of base Session class
export class Session extends AtlasScope implements IWorkspaceSession {
  // NEW: Optional I/O channel for responses
  protected io?: SessionIOChannel;

  constructor(
    // ... existing parameters remain unchanged ...
    responseConfig?: { // NEW optional parameter
      trigger: TriggerConfig;
      responseChannel: ResponseChannel;
    },
  ) {
    // ... existing initialization ...

    // Initialize I/O channel if response config provided
    if (responseConfig?.trigger.response && responseConfig.responseChannel) {
      this.io = this.createIOChannel(
        responseConfig.trigger.response,
        responseConfig.responseChannel,
      );
    }
  }

  // NEW: Methods for response handling
  async stream(data: any): Promise<void> {
    if (!this.io?.output) return;
    await this.io.output.write(data);
  }

  async respond(data: any): Promise<void> {
    if (!this.io?.output) return;

    if (this.io.mode === "unary") {
      await this.io.output.write(data);
      await this.io.close("complete");
    } else {
      await this.stream(data);
    }
  }

  // UPDATED: Override complete to handle response channels
  async complete(result?: any): Promise<void> {
    if (this.io) {
      if (this.io.mode === "streaming") {
        await this.stream({ type: "complete" });
      } else if (this.io.mode === "unary" && result) {
        await this.respond(result);
      }
      await this.io.close("complete");
    }
    // ... existing complete logic ...
  }

  // UPDATED: Override fail to handle response channels
  async fail(error: Error): Promise<void> {
    if (this.io) {
      await this.stream({ type: "error", error: error.message });
      await this.io.close("error");
    }
    // ... existing fail logic ...
  }
}
```

Key points:

- **No breaking changes** - only optional parameters added
- **Graceful degradation** - sessions work normally without response config
- **Clean lifecycle** - channels properly closed on complete/fail

#### Agent Feature Detection

Agents receive enhanced task context to detect and use response capabilities:

```typescript
// SessionSupervisor provides enhanced task context
interface EnhancedTask extends Task {
  session: {
    hasResponseChannel: boolean;
    responseMode?: "unary" | "streaming" | "interactive";
    canStream: boolean;
    stream?: (data: any) => Promise<void>;
    respond?: (data: any) => Promise<void>;
  };
}
```

##### Common Agent Patterns

**Pattern 1: Progressive Enhancement**

```typescript
class AnalysisAgent extends BaseAgent {
  async execute(task: EnhancedTask, session: Session) {
    const data = await this.loadData(task.input);

    // Stream progress if available
    if (task.session.canStream) {
      await task.session.stream({
        type: "status",
        message: "Starting analysis...",
        progress: 0,
      });
    }

    // Process with optional progress updates
    for (let i = 0; i < data.length; i++) {
      const result = await this.analyzeItem(data[i]);

      if (task.session.canStream) {
        await task.session.stream({
          type: "progress",
          current: i + 1,
          total: data.length,
          currentItem: data[i].name,
        });
      }
    }

    // Works regardless of response mode
    return { analysis: results };
  }
}
```

**Pattern 2: Mode-Specific Behavior**

```typescript
class ConversationAgent extends BaseAgent {
  async execute(task: EnhancedTask, session: Session) {
    const { message, history } = task.input;

    switch (task.session.responseMode) {
      case "streaming":
        // Stream tokens as they generate
        const stream = await this.llm.createStream(prompt);
        for await (const token of stream) {
          await task.session.stream({ type: "token", content: token });
        }
        break;

      case "unary":
        // Generate complete response
        const response = await this.llm.complete(prompt);
        return { response };

      default:
        // Fire-and-forget - just log
        this.llm.complete(prompt).then((r) =>
          this.logger.info("Completed generation", { length: r.length })
        );
    }
  }
}
```

**Pattern 3: Capability-Based Format Selection**

```typescript
class DataExportAgent extends BaseAgent {
  async execute(task: EnhancedTask, session: Session) {
    const data = await this.collectData(task.input);

    // Adapt output format based on response mode
    if (task.session.responseMode === "streaming") {
      // Stream as JSONL
      for (const record of data) {
        await task.session.stream(JSON.stringify(record) + "\n");
      }
    } else if (task.session.responseMode === "unary") {
      // Return as JSON array
      return { records: data };
    } else {
      // Fire-and-forget - save to storage
      await this.storage.save(`export-${Date.now()}`, data);
      return { saved: true };
    }
  }
}
```

Key principles:

- **Agents work in any context** - with or without response channels
- **Progressive enhancement** - better UX when streaming is available
- **No hard dependencies** - graceful degradation to standard behavior
- **Same agent, multiple triggers** - reusable across different response modes

#### Unary Response Flow

For API-style request/response:

```typescript
// 1. Client makes request
POST /api/analyze
{ "data": "..." }

// 2. Daemon creates response channel and session
const channel = new UnaryResponseChannel();
const session = new WorkspaceSession(workspace, signal, { 
  trigger, 
  responseChannel: channel 
});

// 3. Daemon WAITS for completion (not fire-and-forget!)
await session.execute();
const result = await channel.getResponse();

// 4. Return normal HTTP response
return new Response(JSON.stringify(result));
```

#### Streaming Response Flow

For conversations and progressive updates:

```typescript
// 1. Client triggers signal
POST /system/conversation/stream
{ "message": "Hello" }

// 2. Daemon creates SSE channel, returns immediately
return { 
  success: true,
  response_channel: {
    type: "sse",
    url: "/sessions/abc-123/stream"
  }
}

// 3. Client connects to SSE endpoint
const events = new EventSource(response_channel.url);

// 4. Session streams results as they're generated
// 5. Channel closes when session completes
```

This architecture enables request/response patterns while preserving Atlas's clean
signal→job→session→agent flow.

#### Response Channel Lifecycle

Response channels are managed by the daemon with multiple cleanup mechanisms:

```typescript
class ResponseChannel {
  private timeout: number;
  private closed = false;

  constructor(
    private sessionId: string,
    private ttl: number = 300_000, // 5 min default
  ) {
    // Safety timeout
    this.timeout = setTimeout(() => this.close("timeout"), ttl);
  }

  async close(reason: "complete" | "error" | "timeout" | "client") {
    if (this.closed) return;
    this.closed = true;

    clearTimeout(this.timeout);

    // Send close event to client
    await this.send({ type: "close", reason });

    // Clean up daemon resources
    AtlasDaemon.removeChannel(this.sessionId);

    // Close underlying stream
    await this.stream.close();
  }
}
```

Cleanup triggers:

1. **Session completion** - Session calls `io.close()` when done
2. **Safety timeout** - Automatic cleanup after TTL
3. **Client disconnect** - Detected via SSE connection drop
4. **Explicit close** - Client can POST to `/sessions/{id}/close`

### Storage vs Memory

- **Memory System** (CoALA) - Lossy, semantic search, AI-optimized
- **Storage System** (KV) - Deterministic, exact retrieval, conversation history

Conversations need storage, not memory.

### Tool Access

Tools available in conversations depend on scope:

- Global: workspace management tools only
- Workspace: inherit tools from target workspace
- Job/Session: inherit from parent scope

### HTTP Semantics

Response types follow standard HTTP patterns:

- Different endpoints for different response modes (`/api/chat` vs `/api/chat/stream`)
- Content negotiation via Accept headers
- No client configuration of server behavior

## Migration Path

1. System workspace runs alongside existing ConversationSupervisor
2. New conversations use system workspace
3. Gradual migration of existing conversations
4. Remove ConversationSupervisor once migrated

## Benefits

- **Dogfooding** - Atlas features built with Atlas
- **Consistency** - Same patterns for all features
- **Extensibility** - Easy to add new conversation capabilities
- **Maintainability** - Single architecture to maintain

## Key Design Decisions

1. **Response Channels**: Extend job trigger configuration (not signal definitions) with optional
   response settings
2. **Per-Trigger Responses**: Same job can support different response patterns (streaming, unary,
   none) based on trigger
3. **Session I/O Channels**: Sessions get optional I/O channels that can be bound to clients,
   storage, or other outputs
4. **HTTP Standards**: Follow REST patterns - different endpoints for different response types, not
   client configuration
5. **System Workspace Routes**: System workspaces get special `/system/*` routes on the daemon
6. **Scope via Payload**: Conversation scope (global/workspace/job/session) passed in signal
   payload, not URL structure

## Future Possibilities

The response channel architecture enables:

- Progress monitoring for long-running jobs
- Interactive wizards and workflows
- Live debugging and inspection
- Real-time visualizations
- Multi-client broadcasting

## Conversation History & Resume

The conversation system supports viewing and resuming past conversations:

### Storage Schema

```typescript
interface ConversationRecord {
  id: string;
  scope: ConversationScope;
  userId: string;
  title: string; // Generated from first message
  lastMessage: Date;
  messageCount: number;
  metadata: {
    workspaceName?: string;
    jobName?: string;
    sessionId?: string;
  };
}
```

### History Management

The existing ConversationSupervisorAgent is extended to handle storage:

```typescript
// Extends existing BaseConversationAgent
class ConversationSupervisorAgent extends BaseConversationAgent {
  private sessionManager: ConversationSessionManager;

  async execute(task: Task, session: Session) {
    const { message, scope, userId, conversationId } = task.input;

    // Use existing ConversationSessionManager (now KV-backed)
    const convSession = await this.sessionManager.getOrCreateSession(
      conversationId,
      scope.workspaceId || "atlas-global",
      userId,
    );

    // Add message to history
    this.sessionManager.addMessage(
      convSession.id,
      messageId,
      userId,
      message,
      "user",
    );

    // Use existing ConversationSupervisor streaming
    const supervisor = new ConversationSupervisor(scope.workspaceId);

    // Stream response using existing infrastructure
    for await (
      const event of supervisor.processMessage(
        convSession.id,
        messageId,
        message,
        userId,
        convSession.messageHistory,
      )
    ) {
      // Connect to session I/O if available
      if (task.session.canStream) {
        await task.session.stream(event);
      }
    }

    return { sessionId: convSession.id };
  }
}
```

### Interactive CLI Commands

```typescript
const ConversationCommands = {
  "/history": async () => {
    const response = await fetch("/system/conversation/list", {
      method: "POST",
      body: JSON.stringify({
        userId: "cli-user",
        scope: currentScope,
      }),
    });
    const { conversations } = await response.json();
    // Display list for selection
  },

  "/resume": async (conversationId: string) => {
    const response = await fetch("/system/conversation/resume", {
      method: "POST",
      body: JSON.stringify({
        conversationId,
        userId: "cli-user",
      }),
    });
    // Load conversation context
  },
};
```

## Complete Workspace Definition

```yaml
version: "1.0"

workspace:
  name: "atlas-conversation"
  description: "Conversation management for Atlas"

# Tool definitions via MCP
tools:
  mcp:
    servers:
      atlas-tools:
        command: "atlas-mcp-server"
        args: ["--workspace", "{{WORKSPACE_ID}}"]

# Signals
signals:
  conversation-stream:
    description: "Handle conversation with streaming response"
    provider: "http"
    path: "/conversation/stream"
    method: "POST"
    schema:
      type: "object"
      properties:
        message:
          type: "string"
        userId:
          type: "string"
        scope:
          type: "object"
          properties:
            workspaceId:
              type: "string"
            jobId:
              type: "string"
            sessionId:
              type: "string"
      required: ["message", "userId"]

  conversation-list:
    description: "List conversations for user and scope"
    provider: "http"
    path: "/conversation/list"
    method: "POST"
    schema:
      type: "object"
      properties:
        userId:
          type: "string"
        scope:
          type: "object"
      required: ["userId"]

  conversation-resume:
    description: "Resume a previous conversation"
    provider: "http"
    path: "/conversation/resume"
    method: "POST"
    schema:
      type: "object"
      properties:
        conversationId:
          type: "string"
        userId:
          type: "string"
      required: ["conversationId", "userId"]

# Jobs
jobs:
  handle-conversation:
    name: "handle-conversation"
    description: "Process conversation messages with context awareness"
    triggers:
      - signal: "conversation-stream"
        # PROPOSED: response configuration
        response:
          mode: "streaming"
          format: "sse"
    session_prompts:
      planning: |
        Determine the conversation scope and required context.
        Load appropriate conversation history.
        Plan response approach based on available tools.
    execution:
      strategy: "sequential"
      agents:
        - id: "conversation-agent"
      context:
        filesystem:
          patterns:
            - "workspace.yml"
            - "CLAUDE.md"
          include_content: true
    resources:
      estimated_duration_seconds: 30

  list-conversations:
    name: "list-conversations"
    description: "Query conversation history"
    triggers:
      - signal: "conversation-list"
        # PROPOSED: unary response
        response:
          mode: "unary"
    execution:
      strategy: "sequential"
      agents:
        - id: "conversation-query"

  resume-conversation:
    name: "resume-conversation"
    description: "Load conversation for resumption"
    triggers:
      - signal: "conversation-resume"
        response:
          mode: "unary"
    execution:
      strategy: "sequential"
      agents:
        - id: "conversation-loader"

# Agents
agents:
  conversation-agent:
    type: "llm"
    model: "claude-3-5-sonnet-20241022"
    purpose: "Handle conversations with scope awareness"
    system_prompt: |
      You are Atlas Assistant. You help users with their Atlas workspaces.

      When handling conversations:
      1. Understand the current scope (global, workspace, job, or session)
      2. Use appropriate tools based on the scope
      3. Maintain conversation continuity
      4. Be helpful and concise

      Available context will be provided including conversation history
      and workspace-specific information.

  conversation-query:
    type: "llm"
    model: "claude-3-5-haiku-20241022"
    purpose: "Query conversation history based on scope"
    system_prompt: |
      Query the conversation storage to list conversations.
      Filter by user ID and scope hierarchy.
      Return formatted list with metadata.

  conversation-loader:
    type: "llm"
    model: "claude-3-5-haiku-20241022"
    purpose: "Load conversation history for resumption"
    system_prompt: |
      Load conversation metadata and message history.
      Verify user access permissions.
      Return last N messages and context for resumption.
```

## Open Questions

1. How to handle conversation-specific UI updates (typing indicators, etc.)?
2. Should other features (monitoring, logging) also be system workspaces?
3. How to handle conversation-specific authentication/permissions?
