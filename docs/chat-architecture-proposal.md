# Atlas Chat Architecture Proposal

## Executive Summary

This proposal outlines a new Chat primitive for Atlas that leverages the Vercel AI SDK's transport contract to create persistent, resumable conversations. The new architecture replaces the brittle SSE-only system with a robust, SDK-native HTTP streaming approach that supports disconnection/reconnection, multiple concurrent chats, and proper message persistence.

### Key Architectural Principles

1. **Session Supervisors Own All Emissions**: Session supervisors maintain sole authority over what gets emitted about their session's progress through callback control.

2. **MCP Notification Relay**: Agents emit progress through MCP notifications that flow back through orchestrator callbacks to the supervisor, preserving architectural boundaries.

3. **Chat as Stream Aggregator**: The chat primitive aggregates multiple session streams (conversation + triggered workspaces) into a single HTTP stream endpoint with differentiated event types.

4. **Single Client Stream**: UI consumes one stream with both conversation messages and sidebar session progress using AI SDK's custom data events.

## Current Problems

1. **Lost Sessions**: Stream disconnection means permanent loss of conversation context
2. **No Persistence**: Chat messages stored only in memory, lost on daemon restart
3. **No Resume**: Users cannot reconnect to existing chats or have multiple chats
4. **Complexity**: Custom streaming implementation with session queuing is fragile
5. **Limited Features**: No support for chat history, search, or cross-session context

## Proposed Solution: Chat Primitive

### Core Concepts

A **Chat** is a first-class entity in Atlas that:

- Has a unique, persistent ID (UUID)
- Persists all messages to Deno KV storage
- Maintains connection state independent of HTTP streams
- Tracks related sessions and artifacts
- Supports multiple concurrent client connections

### Architecture Components

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│  Web Client │────▶│  Chat API   │────▶│ Chat Store  │
│   useChat   │     │  Transport  │     │  (Deno KV)  │
└─────────────┘     └─────────────┘     └─────────────┘
                            │
                            ▼
                    ┌───────────────┐
                    │  Conversation │
                    │   Workspace   │
                    └───────────────┘
```

### 1. Chat Storage Layer

Extend Deno KV storage (already used for artifacts) to persist chats:

```typescript
// packages/core/src/chat/storage.ts
interface Chat {
  id: string;
  userId: string;
  workspaceId?: string; // Optional - chats can exist standalone or be workspace-scoped
  createdAt: Date;
  updatedAt: Date;
  title?: string;
  metadata: Record<string, unknown>;
}

// Note: Merge AtlasUIMessage and SessionUIMessage into a unified type
interface ChatMessage extends AtlasUIMessage {
  chatId: string;
  timestamp: Date;
  sessionId?: string; // Links to Atlas session if applicable
}

class ChatStorage {
  private kv: Deno.Kv;

  async createChat(userId: string, workspaceId?: string): Promise<Chat>;
  async getChat(chatId: string): Promise<Chat | null>;
  async listChats(userId: string): Promise<Chat[]>;

  async appendMessage(chatId: string, message: ChatMessage): Promise<void>;
  async getMessages(
    chatId: string,
    limit?: number,
    offset?: number,
  ): Promise<ChatMessage[]>;
  async updateMessages(chatId: string, messages: ChatMessage[]): Promise<void>;
}
```

Key patterns:

- Use composite keys: `["chat", chatId]`, `["chat_message", chatId, timestamp]`
- No indexing by user or workspace for now - keep storage simple

### 2. AI SDK Transport Implementation

Implement the AI SDK's pattern of sending only the latest message:

```typescript
// packages/core/src/chat/transport.ts
import { ChatTransport, UIMessageChunk } from "ai";

export class AtlasChatTransport implements ChatTransport {
  constructor(
    private daemonUrl: string,
    private workspaceId: string,
    private userId: string,
  ) {}

  async sendMessages({
    chatId,
    messages, // Only contains the latest user message
    abortSignal,
    options,
  }): Promise<ReadableStream<UIMessageChunk>> {
    // Extract the latest message (should be only one)
    const latestMessage = messages[messages.length - 1];

    // POST to server with minimal payload using Hono RPC client
    const response = await client.chat.messages.$post({
      json: {
        id: chatId, // Optional - server creates if not provided
        message: latestMessage.content,
        // Don't send full history - server loads from storage
      },
      header: {
        "X-User-Id": this.userId,
        "X-Workspace-Id": this.workspaceId,
      },
    }, { signal: abortSignal });

    // Return the stream body
    if (!response.ok) {
      throw new Error(`Chat request failed: ${response.statusText}`);
    }

    return response.body;
  }

  async reconnectToStream({
    chatId,
  }): Promise<ReadableStream<UIMessageChunk> | null> {
    // Check if there's an active stream for this chat
    const response = await client.chat[":chatId"].stream.$get({
      param: { chatId },
    });

    if (!response.ok || response.status === 204) {
      return null;
    }

    return response.body;
  }
}
```

### 3. Updated Conversation Agent

Modify the conversation agent to follow server-side message handling and workspace triggering:

```typescript
// packages/system/agents/conversation/conversation.agent.ts
export const conversationAgent = createAgent({
  handler: async (prompt, { session, logger, tools, stream, abortSignal }) => {
    const chatId = session.metadata?.chatId || session.streamId;

    // Server loads full history - not sent from client
    const history = chatId ? await chatStorage.getMessages(chatId) : [];

    // Server generates ID for user message
    const userMessage: ChatMessage = {
      id: crypto.randomUUID(), // Server-generated
      role: "user",
      content: prompt, // This is the only content from client
      chatId,
      timestamp: new Date(),
      sessionId: session.sessionId,
    };

    // Persist user message immediately
    if (chatId) {
      await chatStorage.appendMessage(chatId, userMessage);
    }

    // Build full context from persisted history + new message
    const messages = [...history, userMessage];

    // Stream response with server-generated assistant message ID
    const assistantMessageId = crypto.randomUUID();

    const result = streamText({
      model: anthropic("claude-3-5-sonnet"),
      messages: convertToModelMessages(messages),
      tools: {
        ...tools,
        // Tool for triggering other workspaces from chat
        atlas_workspace_signals_trigger: tool({
          description: "Trigger an Atlas workspace to perform a task",
          parameters: z.object({
            signal_id: z.string(),
            payload: z.record(z.unknown()),
          }),
          execute: async ({ signal_id, payload }) => {
            // CRITICAL: Pass the chat's streamId to triggered sessions
            // This enables multi-session aggregation
            const result = await triggerWorkspaceSignal({
              signalId: signal_id,
              payload,
              metadata: {
                parentStreamId: session.streamId, // Share the chat's stream
                parentSessionId: session.sessionId,
                chatId: chatId,
                isTriggeredFromChat: true,
              },
            });

            // Emit a custom data event for UI to track triggered session
            stream.emit({
              type: "data",
              data: {
                kind: "session-triggered",
                sessionId: result.sessionId,
                workspaceId: result.workspaceId,
                signalId: signal_id,
                timestamp: Date.now(),
              },
            });

            return result;
          },
        }),
      },
      onStart: async () => {
        // Emit assistant message ID to client immediately
        stream.emit({
          type: "message-id",
          id: assistantMessageId,
        });
      },
      onFinish: async (completion) => {
        // Persist assistant message
        if (chatId) {
          await chatStorage.appendMessage(chatId, {
            id: assistantMessageId,
            role: "assistant",
            content: completion.text,
            chatId,
            timestamp: new Date(),
            sessionId: session.sessionId,
          });
        }
      },
      // ... rest of config
    });
  },
});
```

### 4. REST API Endpoints (Hono Implementation)

Leveraging Hono's streaming helpers for HTTP streaming compatible with AI SDK:

```typescript
// apps/atlasd/routes/chat.ts
import { Hono } from "hono";
import { stream } from "hono/streaming";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";

const app = new Hono();

// Schema validation for chat requests
const chatRequestSchema = z.object({
  id: z.string().uuid().optional(),
  message: z.string().min(1).max(10000),
});

// Active stream registry for resumption
const activeStreams = new Map<string, AbortController>();

// POST /api/chat - Main chat endpoint with HTTP streaming
app.post("/api/chat", zValidator("json", chatRequestSchema), async (c) => {
  const { id: chatId, message } = c.req.valid("json");
  const userId = c.req.header("X-User-Id");
  const workspaceId = c.req.header("X-Workspace-Id");

  // Server-side chat creation/retrieval
  let chat: Chat;
  if (chatId) {
    chat = await chatStorage.getChat(chatId);
    if (!chat) {
      return c.json({ error: "Chat not found" }, 404);
    }
  } else {
    chat = await chatStorage.createChat(userId, workspaceId);
  }

  // Track active stream for resumption
  const abortController = new AbortController();
  activeStreams.set(chat.id, abortController);

  // Return HTTP stream with Hono's helper (AI SDK uses custom streaming, not SSE)
  return stream(c, async (stream) => {
    // Set custom headers
    c.header("X-Chat-Id", chat.id);
    c.header("Content-Type", "text/plain; charset=utf-8");
    c.header("Content-Encoding", "identity"); // Cloudflare compatibility

    try {
      // Create chat stream aggregator
      const chatAggregator = new ChatStreamAggregator(chat.id, null);

      // Trigger conversation workspace with aggregator context
      const { streamId, onStreamEvent } = chatAggregator.attachSession(
        crypto.randomUUID(), // Primary session ID
        true, // isPrimary
      );

      const sessionPromise = triggerSignal("conversation-stream", {
        chatId: chat.id,
        message,
        userId,
        workspaceId,
        streamId, // Use aggregator's streamId
        signal: abortController.signal,
      });

      // Subscribe to aggregated events from all sessions
      chatAggregator.onEvent(async (event) => {
        // Write UI message chunks directly as JSON lines
        const chunk = JSON.stringify(event) + "\n";
        await stream.write(new TextEncoder().encode(chunk));
      });

      // Wait for session completion
      await sessionPromise;

      // Signal stream end by closing
      await stream.close();
    } catch (error) {
      // Send error as final chunk
      console.error("Chat stream error:", error);
      const errorChunk = JSON.stringify({
        type: "error",
        error: error.message,
        chatId: chat.id,
      }) + "\n";
      await stream.write(new TextEncoder().encode(errorChunk));
    } finally {
      // Cleanup active stream tracking
      activeStreams.delete(chat.id);
      abortController.abort();
    }
  });
});

// GET /api/chat/:chatId - Get chat metadata and messages
app.get("/api/chat/:chatId", async (c) => {
  const chatId = c.req.param("chatId");
  const chat = await chatStorage.getChat(chatId);

  if (!chat) {
    return c.json({ error: "Chat not found" }, 404);
  }

  const messages = await chatStorage.getMessages(chatId);
  return c.json({ chat, messages });
});

// GET /api/chat/:chatId/stream - Resume active stream
// NOTE: This endpoint may not be necessary since the AI SDK's useChat hook
// handles reconnection automatically through the main /api/chat endpoint.
// Keeping it here for manual reconnection scenarios if needed.
app.get("/api/chat/:chatId/stream", async (c) => {
  const chatId = c.req.param("chatId");

  // Check if there's an active stream
  if (!activeStreams.has(chatId)) {
    return c.body(null, 204);
  }

  // Get existing stream state
  const streamState = await getStreamState(chatId);

  return stream(c, async (stream) => {
    try {
      // Send current state as first chunk
      const resumeChunk = JSON.stringify({
        type: "resume",
        data: streamState,
      }) + "\n";
      await stream.write(new TextEncoder().encode(resumeChunk));

      // Subscribe to ongoing events
      const eventEmitter = streamState.eventEmitter;
      const messageHandler = async (event: CustomEvent) => {
        const chunk = JSON.stringify({
          type: event.detail.type,
          data: event.detail.data,
          id: event.detail.id || crypto.randomUUID(),
        }) + "\n";
        await stream.write(new TextEncoder().encode(chunk));
      };

      eventEmitter.addEventListener("message", messageHandler);

      // Keep alive until stream completes
      await streamState.completion;

      eventEmitter.removeEventListener("message", messageHandler);
      await stream.close();
    } catch (error) {
      const errorChunk = JSON.stringify({
        type: "error",
        error: error.message,
      }) + "\n";
      await stream.write(new TextEncoder().encode(errorChunk));
    }
  });
});

// GET /api/chats - List user's chats with pagination
app.get("/api/chats", async (c) => {
  const userId = c.req.header("X-User-Id");
  const limit = Number(c.req.query("limit")) || 50;
  const offset = Number(c.req.query("offset")) || 0;

  const chats = await chatStorage.listChats(userId, { limit, offset });
  return c.json(chats);
});

// DELETE /api/chat/:chatId - Delete a chat
app.delete("/api/chat/:chatId", async (c) => {
  const chatId = c.req.param("chatId");
  const userId = c.req.header("X-User-Id");

  // Verify ownership
  const chat = await chatStorage.getChat(chatId);
  if (!chat || chat.userId !== userId) {
    return c.json({ error: "Chat not found" }, 404);
  }

  // Abort any active streams
  const controller = activeStreams.get(chatId);
  if (controller) {
    controller.abort();
    activeStreams.delete(chatId);
  }

  await chatStorage.deleteChat(chatId);
  return c.body(null, 204);
});

export default app;
```

### Hono Streaming Improvements

The Hono implementation provides several advantages over generic HTTP streaming:

#### Built-in Streaming Support

- `stream()` helper handles HTTP streaming with proper connection management
- Direct control over chunk writing for AI SDK compatibility
- Flexible format supporting JSON line-delimited streaming

#### Error Handling

- Try-catch blocks for clean error handling within streams
- Errors sent as JSON chunks in the stream
- Proper cleanup in finally blocks

#### Connection Management

- `onAbort()` callback for clean disconnection handling
- AbortController integration for cancellable operations
- Active stream registry for resumption support

#### Type Safety

- Zod validation on request bodies
- Typed message structures for streaming
- Proper error boundaries

#### Cloudflare Compatibility

- `Content-Encoding: identity` header for Cloudflare Workers
- Handles known streaming issues with Wrangler

#### Event Architecture

- EventTarget/EventEmitter pattern for decoupled message passing
- Clean separation between HTTP layer and workspace processing
- Support for transient vs persistent event types

### 5. Web Client Integration

Update the web client to use the AI SDK's useChat hook with minimal message sending:

```typescript
// apps/web-client/src/lib/modules/chat/use-atlas-chat.ts
import { useChat } from "ai/react";
import { AtlasChatTransport } from "./transport";

export function useAtlasChat(initialChatId?: string) {
  const transport = new AtlasChatTransport(daemonUrl, workspaceId, userId);

  const chat = useChat({
    id: initialChatId,
    transport,
    resume: true, // Enable automatic stream resumption

    // Client configuration
    sendExtraMessageFields: false, // Don't send metadata
    keepLastMessageOnError: true, // Retry support

    onResponse: (response) => {
      // Extract server-generated chat ID from headers
      const chatId = response.headers.get("X-Chat-Id");
      if (chatId && !chat.id) {
        // Update local chat ID with server-generated value
        chat.setId(chatId);
      }
    },

    onFinish: (message) => {
      // Message already persisted server-side
      // Just update UI state
    },

    onData: (data) => {
      // Handle streaming data parts (artifacts, progress, etc.)
    },
  });

  return {
    ...chat,
    // Additional Atlas-specific methods
    loadHistory: async () => {
      if (!chat.id) return;

      const response = await fetch(`/api/chat/${chat.id}`);
      const { messages } = await response.json();

      // Update local state with full history
      chat.setMessages(messages);
    },
  };
}
```

### 6. Multi-Session Aggregation Architecture

The chat primitive aggregates progress from multiple sessions (conversation + triggered workspaces) into a single stream:

#### Event Flow Architecture

```
Session Supervisor (Primary Conversation)
    ↓ onStreamEvent callback
Orchestrator → MCP → Agent Server
    ↓                      ↓
Conversation Agent    stream.emit()
    ↓                      ↓
Triggers workspace    MCP Notification
    ↓                      ↓
                    Orchestrator handler
                           ↓
                    Session callback
                           ↓
                    HTTPStreamEmitter
                           ↓
                      Chat Stream

Session Supervisor (Triggered Workspace)
    ↓ onStreamEvent callback
Orchestrator → MCP → Agent Server
    ↓                      ↓
Other Agents         stream.emit()
    ↓                      ↓
                    MCP Notification
                           ↓
                    Session callback
                           ↓
                    Same HTTPStreamEmitter
                           ↓
                      Chat Stream
```

**Key Principle**: Session supervisors maintain authority over all emissions. Agents emit through MCP notifications that flow back through orchestrator callbacks to the supervisor.

#### Chat Stream Aggregator

```typescript
// packages/core/src/chat/stream-aggregator.ts
export class ChatStreamAggregator {
  private streamId: string;
  private primarySessionId: string;
  private httpStreamEmitter: HTTPStreamEmitter;

  constructor(chatId: string, primarySessionId: string) {
    this.streamId = chatId; // Use chatId as streamId
    this.primarySessionId = primarySessionId;
    this.httpStreamEmitter = new HTTPStreamEmitter(this.streamId);
  }

  /**
   * Attach a session supervisor's emissions to this chat.
   * All sessions share the same HTTPStreamEmitter but events
   * are transformed based on whether they're primary or triggered.
   */
  attachSession(sessionId: string, isPrimary: boolean = false) {
    // Session supervisors will use this streamId
    // Their events flow through MCP notification chain
    return {
      streamId: this.streamId,
      onStreamEvent: (event: SessionUIMessageChunk) => {
        this.handleSessionEvent({ ...event, sessionId });
      },
    };
  }

  private handleSessionEvent(
    event: SessionUIMessageChunk & { sessionId: string },
  ) {
    if (event.sessionId === this.primarySessionId) {
      // Main conversation events - standard AI SDK format
      this.httpStreamEmitter.emit(event);
    } else {
      // Triggered session events - custom data format for sidebar
      this.httpStreamEmitter.emit({
        type: "data",
        data: {
          kind: "session-progress",
          sessionId: event.sessionId,
          agentId: event.data?.agentId,
          status: this.mapEventToStatus(event.type),
          event: event, // Original event nested
          timestamp: Date.now(),
        },
      });
    }
  }

  private mapEventToStatus(eventType: string): string {
    switch (eventType) {
      case "data-agent-start":
        return "agent-starting";
      case "data-agent-finish":
        return "agent-complete";
      case "data-session-finish":
        return "session-complete";
      case "text-delta":
        return "processing";
      default:
        return "active";
    }
  }
}
```

#### Session Supervisor Integration

```typescript
// In session-supervisor-actor.ts
async initializeSession(context: SessionContext): Promise<void> {
  // For triggered sessions, use parent's streamId
  const streamId = context.metadata?.parentStreamId || context.streamId;
  const isTriggeredSession = !!context.metadata?.parentStreamId;

  if (streamId) {
    this.baseStreamEmitter = new HTTPStreamEmitter(
      streamId,
      this.sessionId,
      this.logger
    );

    // Emit session start with context
    this.baseStreamEmitter.emit({
      type: 'data-session-start',
      data: {
        sessionId: this.sessionId,
        isTriggeredSession,
        parentSessionId: context.metadata?.parentSessionId,
        workspaceId: this.workspaceId,
        signalId: context.signal.id
      }
    });
  }
}
```

#### Client-Side Consumption

```typescript
// Client receives single stream with both conversation and session progress
const { messages, data } = useChat({
  api: '/api/chat'
});

// Parse session progress from custom data events
const sessionProgress = useMemo(() => {
  const sessions = new Map();

  data?.forEach(item => {
    if (item.kind === 'session-progress') {
      const { sessionId, status, agentId, timestamp } = item;

      if (!sessions.has(sessionId)) {
        sessions.set(sessionId, []);
      }

      sessions.get(sessionId).push({
        agentId,
        status,
        timestamp
      });
    }
  });

  return sessions;
}, [data]);

// Render UI
return (
  <div className="flex">
    <ChatMessages messages={messages} />
    <SessionsSidebar>
      {Array.from(sessionProgress.entries()).map(([sessionId, events]) => (
        <SessionProgress
          key={sessionId}
          sessionId={sessionId}
          events={events}
        />
      ))}
    </SessionsSidebar>
  </div>
);
```

## Migration Strategy

### Phase 1: Foundation

1. Implement ChatStorage with Deno KV
2. Create chat REST endpoints with server-side ID generation
3. Add chat ID to session metadata

### Phase 2: Transport

1. Implement AtlasChatTransport with single-message sending
2. Update conversation agent for server-side message handling
3. Test with existing web client

### Phase 3: Integration

1. Update web client to use useChat hook with minimal payload
2. Add chat listing and history UI
3. Implement session progress tracking

### Phase 4: Deprecation

1. Mark old streaming endpoints as deprecated
2. Migrate existing active streams to chats
3. Update documentation

## Key Design Decisions

### Workspace Scoping

- **Chats are optionally workspace-scoped** - Can exist standalone or be tied to specific workspaces
- **Flexibility for future use cases** - Supports both general chat and workspace-specific conversations

### Message Type Unification

- **Merge AtlasUIMessage and SessionUIMessage** - Eliminates confusion from unnecessary split
- **Single message type** - Consistent interface across the system

### Single Message Transmission

- **Client sends only the latest message** - Reduces payload size and network overhead
- **Server loads full history from storage** - Single source of truth for conversation state
- **Server generates all IDs** - Prevents ID conflicts and simplifies client logic

### Message Persistence Pattern

- **User messages persisted before processing** - Ensures no data loss
- **Assistant messages streamed with ID first** - Client knows the message ID immediately
- **Assistant messages persisted on completion** - Full response stored atomically

### Stream Management

- **Stateless HTTP stream connections** - Can reconnect from any client
- **Chat-scoped streams** - Multiple clients can observe same chat
- **Transient progress events** - Session updates don't pollute message history

### MCP Notification Relay Architecture

The system preserves session supervisor authority through a notification relay pattern:

1. **Session Supervisors Own Emissions**: Session supervisors provide `onStreamEvent` callbacks to orchestrators, maintaining control over what gets emitted.

2. **Agents Use MCP Notifications**: Agents call `stream.emit()` which triggers MCP notifications, not direct HTTPStreamEmitter access.

3. **Notification Flow**:
   - Agent `stream.emit()` → MCP Server notification
   - MCP notification → Orchestrator handler
   - Orchestrator handler → Session Supervisor callback
   - Supervisor callback → HTTPStreamEmitter → HTTP stream to client

4. **Real-time Progress**: This pattern enables long-running agents to report incremental progress while maintaining architectural boundaries.

### Multi-Session Stream Aggregation

The chat primitive acts as an aggregation point for multiple session streams:

1. **Shared StreamId**: Multiple session supervisors can share the same streamId (the chatId).

2. **Event Differentiation**: Events carry sessionId to identify their source.

3. **Transform by Source**:
   - Primary conversation events → Standard AI SDK format
   - Triggered session events → Custom data format for sidebar

4. **Single Client Stream**: Client consumes one HTTP stream with all session events, simplifying UI complexity.

This approach maintains clean separation of concerns while providing rich, real-time multi-session visibility.

## Backwards Compatibility

- Old streaming endpoints remain functional during migration
- Stream IDs can optionally map to chat IDs
- Existing conversation agent works with minor modifications
- No breaking changes to workspace signal interface

## Security Considerations

1. **Access Control**: Chats scoped to user + workspace
2. **Rate Limiting**: Per-user chat creation limits
3. **Storage Limits**: Max messages per chat, auto-archive old chats
4. **Audit Trail**: Track all chat operations in daemon logs

## Performance Considerations

1. **Message Pagination**: Load recent messages, lazy-load history
2. **Stream Buffering**: Buffer events before persisting
3. **KV Transactions**: Batch message writes
4. **Cache Layer**: In-memory cache for active chats

## Open Questions

1. Should we support chat templates/presets?
2. How do we handle chat forking/branching?
3. What's the retention policy for old chats?
4. Should chats support collaborative editing?
5. How do we handle chat export/import?

## Architecture Validation (Red Team Analysis)

### Potential Concerns & Mitigations

1. **Concern: Agents bypassing supervisor control**
   - **Mitigation**: Agents don't have direct access to HTTPStreamEmitter. They emit through MCP notifications that flow through orchestrator callbacks controlled by supervisors.

2. **Concern: Event intermixing from multiple sessions**
   - **Mitigation**: All events carry sessionId for clear attribution. ChatStreamAggregator transforms events based on source (primary vs triggered).

3. **Concern: Lost progress from triggered sessions**
   - **Mitigation**: Triggered sessions share the chat's streamId, ensuring their events flow to the same aggregation point.

4. **Concern: Complexity of notification chain**
   - **Mitigation**: Each layer has clear responsibility: Agents report, MCP relays, Orchestrators route, Supervisors control, Chat aggregates.

5. **Concern: Client handling multiple event types**
   - **Mitigation**: AI SDK's `useChat` hook natively supports custom data events. Session progress uses standardized `kind` field for easy filtering.

### Architectural Invariants

These properties must be maintained:

1. **No Direct Emission**: Agents must never directly access HTTPStreamEmitter
2. **Callback Authority**: Session supervisors must provide all emission callbacks
3. **Event Attribution**: Every event must carry sessionId
4. **Stream Sharing**: Triggered sessions must use parent's streamId
5. **Transform Consistency**: ChatStreamAggregator must consistently transform by session type

## Next Steps

1. Review and approve proposal
2. Create detailed technical specifications
3. Set up feature branch
4. Begin Phase 1 implementation
5. Regular sync meetings for progress updates
