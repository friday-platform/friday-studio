# Chat POC Implementation Plan

## Overview

Full backend implementation of chat with AI SDK-compatible streaming using a hybrid SSE approach. This enables multi-client observation while conforming to the AI SDK's transport contract.

## Architecture Strategy

New backend flow (SSE-backed ReadableStream):

1. POST to `/api/chat` with message
2. Server persists message to storage, returns streamId
3. Server triggers conversation agent with chat context in background
4. Client creates ReadableStream backed by SSE connection
5. Agent loads full chat history and streams response
6. Events flow through SSE to all connected clients
7. Response persisted to storage on completion
8. Multiple clients can observe same chat stream

What's NOT in scope:

- Frontend/UI changes (another engineer)
- Multi-session aggregation (conversation triggering other workspaces)
- Backwards compatibility with old SSE endpoints

## Key Changes

### 1. Chat Storage Layer (Deno KV)

**Location**: `packages/core/src/chat/storage.ts`

Create storage following the same pattern as artifacts storage:

```typescript
import type { SessionUIMessage } from "@atlas/core";
import { fail, type Result, success } from "@atlas/utils";
import { getAtlasHome } from "@atlas/utils/paths.server";
import { join } from "@std/path";

interface Chat {
  id: string; // Same as streamId
  userId: string;
  workspaceId: string;
  createdAt: string;
  updatedAt: string;
}

// Key types for type safety
type ChatKey = ["chat", string];
type MessageKey = ["chat_message", string, string]; // [prefix, chatId, timestamp]
type MessagesByChat = ["messages_by_chat", string];

const keys = {
  chat: (id: string): ChatKey => ["chat", id],
  message: (chatId: string, timestamp: string): MessageKey => [
    "chat_message",
    chatId,
    timestamp,
  ],
  messagesByChat: (chatId: string): MessagesByChat => [
    "messages_by_chat",
    chatId,
  ],
};

const kvPath = join(getAtlasHome(), "storage.db");

/** Create chat */
async function createChat(input: {
  chatId: string;
  userId: string;
  workspaceId: string;
}): Promise<Result<Chat, string>> {
  using db = await Deno.openKv(kvPath);

  const chat: Chat = {
    id: input.chatId,
    userId: input.userId,
    workspaceId: input.workspaceId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const result = await db.set(keys.chat(input.chatId), chat);
  if (!result.ok) {
    return fail("Failed to create chat");
  }

  return success(chat);
}

/** Append message to chat */
async function appendMessage(
  chatId: string,
  message: SessionUIMessage,
): Promise<Result<void, string>> {
  using db = await Deno.openKv(kvPath);

  const timestamp = new Date().toISOString();
  const messageKey = keys.message(chatId, timestamp);

  const tx = db.atomic();
  tx.set(messageKey, message);
  tx.set(keys.messagesByChat(chatId), messageKey); // Index for retrieval

  const result = await tx.commit();
  if (!result.ok) {
    return fail("Failed to append message");
  }

  return success(undefined);
}

/** Get chat by ID */
async function getChat(chatId: string): Promise<Result<Chat | null, string>> {
  using db = await Deno.openKv(kvPath);

  const result = await db.get<Chat>(keys.chat(chatId));
  return success(result.value || null);
}

/** Get chat messages */
async function getMessages(
  chatId: string,
  limit = 100,
): Promise<Result<SessionUIMessage[], string>> {
  using db = await Deno.openKv(kvPath);

  const messages: SessionUIMessage[] = [];
  const entries = db.list<SessionUIMessage>({
    prefix: ["chat_message", chatId],
  });

  for await (const entry of entries) {
    if (messages.length >= limit) break;
    if (entry.value) {
      messages.push(entry.value);
    }
  }

  return success(messages);
}

export const ChatStorage = {
  createChat,
  getChat,
  appendMessage,
  getMessages,
};
```

Implementation notes:

- Use Deno KV directly like artifacts storage
- Store in same `storage.db` file
- Key patterns: `["chat", chatId]` and `["chat_message", chatId, timestamp]`
- Natural time-based ordering for messages

### 2. SSE Stream Manager

**Location**: `packages/core/src/chat/sse-manager.ts`

Central hub for managing SSE streams and event distribution:

```typescript
import type { SessionUIMessageChunk } from "@atlas/core";
import { EventEmitter } from "node:events";

interface StreamState {
  streamId: string;
  chatId: string;
  isActive: boolean;
  events: SessionUIMessageChunk[];
  subscribers: Set<(event: SessionUIMessageChunk) => void>;
}

export class SSEStreamManager extends EventEmitter {
  private streams = new Map<string, StreamState>();

  createStream(streamId: string, chatId: string): void {
    this.streams.set(streamId, {
      streamId,
      chatId,
      isActive: true,
      events: [],
      subscribers: new Set(),
    });
  }

  emit(streamId: string, event: SessionUIMessageChunk): void {
    const stream = this.streams.get(streamId);
    if (!stream) return;

    // Store event for late joiners
    stream.events.push(event);

    // Emit to all subscribers
    stream.subscribers.forEach((callback) => {
      try {
        callback(event);
      } catch (error) {
        console.error("SSE subscriber error:", error);
      }
    });
  }

  subscribe(
    streamId: string,
    callback: (event: SessionUIMessageChunk) => void,
  ): () => void {
    const stream = this.streams.get(streamId);
    if (!stream) {
      throw new Error(`Stream ${streamId} not found`);
    }

    // Add subscriber
    stream.subscribers.add(callback);

    // Send buffered events to new subscriber
    stream.events.forEach((event) => {
      callback(event);
    });

    // Return unsubscribe function
    return () => {
      stream.subscribers.delete(callback);
    };
  }

  completeStream(streamId: string): void {
    const stream = this.streams.get(streamId);
    if (stream) {
      stream.isActive = false;
      // Keep stream in memory for late joiners (with TTL in production)
    }
  }

  getStreamState(streamId: string): StreamState | undefined {
    return this.streams.get(streamId);
  }

  // Cleanup old inactive streams (call periodically)
  cleanup(maxAgeMs = 5 * 60 * 1000): void {
    const now = Date.now();
    for (const [streamId, stream] of this.streams) {
      if (!stream.isActive && stream.subscribers.size === 0) {
        // In production, check timestamp
        this.streams.delete(streamId);
      }
    }
  }
}

// Global instance
export const sseManager = new SSEStreamManager();
```

### 3. Chat API Endpoints

**Location**: `apps/atlasd/routes/chat.ts`

Chat endpoints that trigger processing and return streamId:

```typescript
import { ChatStorage } from "@atlas/core/chat/storage";
import { sseManager } from "@atlas/core/chat/sse-manager";
import { daemonFactory } from "../src/factory";
import type { SessionUIMessage, SessionUIMessageChunk } from "@atlas/core";

const chatRoutes = daemonFactory.createApp();

// Event collector for streaming responses
class StreamCollector {
  private assistantContent = "";
  private assistantId?: string;

  constructor(
    private streamId: string,
    private onComplete?: (message: SessionUIMessage | null) => void,
  ) {}

  collect(event: SessionUIMessageChunk) {
    // Track assistant message for persistence
    if (event.type === "text" && !this.assistantId) {
      this.assistantId = crypto.randomUUID();
      this.assistantContent = "";
    }

    if (event.type === "text-delta" && event.data?.textDelta) {
      this.assistantContent += event.data.textDelta;
    }

    // Emit to SSE manager for distribution
    sseManager.emit(this.streamId, event);
  }

  complete() {
    const message = this.getAssistantMessage();
    sseManager.completeStream(this.streamId);
    this.onComplete?.(message);
  }

  private getAssistantMessage(): SessionUIMessage | null {
    if (!this.assistantId || !this.assistantContent) return null;
    return {
      id: this.assistantId,
      role: "assistant",
      content: this.assistantContent,
      createdAt: new Date(),
    };
  }
}

// POST /api/chat - Send message, return streamId
chatRoutes.post("/", async (c) => {
  const ctx = c.get("app");
  const { id: chatId, message } = c.req.valid("json");
  const userId = c.req.header("X-User-Id") || "default-user";
  const workspaceId = c.req.header("X-Workspace-Id") || "atlas-conversation";

  // Create or retrieve chat
  let resolvedChatId = chatId;
  if (!chatId) {
    resolvedChatId = crypto.randomUUID();
    const result = await ChatStorage.createChat({
      chatId: resolvedChatId,
      userId,
      workspaceId,
    });
    if (!result.ok) {
      return c.json({ error: "Failed to create chat" }, 500);
    }
  }

  // Store user message
  const userMessage: SessionUIMessage = {
    id: crypto.randomUUID(),
    role: "user",
    content: message,
    createdAt: new Date(),
  };

  const appendResult = await ChatStorage.appendMessage(
    resolvedChatId,
    userMessage,
  );
  if (!appendResult.ok) {
    return c.json({ error: "Failed to store message" }, 500);
  }

  // Create stream for this request
  const streamId = crypto.randomUUID();
  sseManager.createStream(streamId, resolvedChatId);

  // Trigger conversation in background
  const runtime = await ctx.getOrCreateWorkspaceRuntime(workspaceId);

  const collector = new StreamCollector(streamId, async (assistantMessage) => {
    // Persist assistant message after completion
    if (assistantMessage) {
      await ChatStorage.appendMessage(resolvedChatId, assistantMessage);
    }
  });

  // Start processing (non-blocking)
  runtime
    .triggerSignalWithSession(
      "conversation-stream",
      {
        chatId: resolvedChatId,
        message,
        userId,
      },
      streamId,
      (event: SessionUIMessageChunk) => {
        collector.collect(event);
      },
    )
    .then(() => {
      collector.complete();
    })
    .catch((error) => {
      console.error("Session error:", error);
      sseManager.emit(streamId, {
        type: "error",
        error: error.message,
      });
      sseManager.completeStream(streamId);
    });

  // Return immediately with streamId
  return c.json({
    chatId: resolvedChatId,
    streamId,
  });
});

// GET /api/chat/:chatId - Get chat history
chatRoutes.get("/:chatId", async (c) => {
  const chatId = c.req.param("chatId");

  const chatResult = await ChatStorage.getChat(chatId);
  if (!chatResult.ok || !chatResult.data) {
    return c.json({ error: "Chat not found" }, 404);
  }

  const messagesResult = await ChatStorage.getMessages(chatId);
  if (!messagesResult.ok) {
    return c.json({ error: messagesResult.error }, 500);
  }

  return c.json({
    chat: chatResult.data,
    messages: messagesResult.data,
  });
});

export default chatRoutes;
```

### 4. SSE Streaming Endpoints

**Location**: `apps/atlasd/routes/chat.ts` (merged with chat routes)

SSE endpoints for streaming chat events:

```typescript
// Imports already included in chat.ts

// GET /api/chat/:chatId/streams/:streamId - Subscribe to stream events
chatRoutes.get("/:chatId/streams/:streamId", async (c) => {
  const chatId = c.req.param("chatId");
  const streamId = c.req.param("streamId");

  // Check if stream exists
  const streamState = sseManager.getStreamState(streamId);
  if (!streamState) {
    return c.json({ error: "Stream not found" }, 404);
  }

  // Validate that stream belongs to this chat
  if (streamState.chatId !== chatId) {
    return c.json({ error: "Stream does not belong to this chat" }, 404);
  }

  // Set up SSE streaming
  return streamSSE(c, async (stream) => {
    // Subscribe to stream events
    const unsubscribe = sseManager.subscribe(streamId, (event) => {
      stream.writeSSE({
        data: JSON.stringify(event),
        event: "message",
        id: crypto.randomUUID(),
      });
    });

    // Handle client disconnect
    stream.onAbort(() => {
      unsubscribe();
    });

    // Keep connection alive with periodic pings
    const pingInterval = setInterval(() => {
      stream.writeSSE({
        event: "ping",
        data: "keep-alive",
      });
    }, 30000);

    // Clean up on abort
    stream.onAbort(() => {
      clearInterval(pingInterval);
    });

    // If stream is complete, send completion event
    if (!streamState.isActive) {
      stream.writeSSE({
        event: "complete",
        data: JSON.stringify({ chatId: streamState.chatId }),
      });
    }
  });
});
```

### 5. Workspace Runtime Stream Callback

**Location**: `src/core/workspace-runtime.ts`

Modify `triggerSignalWithSession` to accept stream callback:

```typescript
async triggerSignalWithSession(
  signalId: string,
  payload: Record<string, unknown>,
  streamId: string,
  onStreamEvent?: (event: SessionUIMessageChunk) => void
): Promise<void> {
  const sessionContext = {
    signal,
    payload,
    streamId,
    metadata: {
      chatId: payload.chatId || streamId,
      isChat: !!onStreamEvent,
    },
    // Pass callback through to session
    onStreamEvent,
  };

  // ... trigger session with context
}
```

### 6. Session Supervisor Stream Routing

**Location**: `src/core/actors/session-supervisor-actor.ts`

Route stream events to callback if provided:

```typescript
// In initializeSession() method
async initializeSession(context: SessionContext): Promise<void> {
  // ... existing code ...

  if (context.streamId) {
    // Check if we have a stream callback (chat mode)
    if (context.onStreamEvent) {
      // Use callback emitter that routes to the SSE manager
      this.baseStreamEmitter = new CallbackStreamEmitter(
        context.onStreamEvent,
        () => {}, // onEnd
        (error) => logger.error("Stream error", { error })
      );
    } else {
      // Standard HTTP emitter for non-chat streams (backwards compat)
      this.baseStreamEmitter = new HTTPStreamEmitter(
        context.streamId,
        this.sessionId,
        this.logger
      );
    }
  }
}
```

### 7. Conversation Agent History Loading

**Location**: `packages/system/agents/conversation/conversation.agent.ts`

Load chat history via daemon endpoint:

```typescript
import { createAtlasClient } from "@atlas/oapi-client";

// In handler function around line 130
handler: async (prompt, { session, logger, stream }) => {
  const chatId = session.metadata?.chatId || session.streamId;
  const isChat = session.metadata?.isChat;

  // Load history if available via daemon API
  let messages: SessionUIMessage[] = [];
  if (chatId && isChat) {
    try {
      const client = createAtlasClient();
      const response = await client.GET("/api/chat/{chatId}", {
        params: { path: { chatId } },
      });

      if (response.data) {
        messages = response.data.messages;
      }
    } catch (error) {
      logger.warn("Failed to load chat history", {
        error,
        chatId,
      });
      // Continue without history
    }
  }

  // Convert to AI SDK format for LLM context
  const contextMessages = messages.map((m) => ({
    role: m.role as "user" | "assistant",
    content: m.content,
  }));

  // Current message already persisted by daemon
  contextMessages.push({ role: "user", content: prompt });

  // Continue with existing streaming logic
  const result = streamText({
    model: anthropic("claude-sonnet-4-5"),
    messages: contextMessages,
    // ... rest unchanged
  });
};
```

### 8. AI SDK Transport Implementation (Frontend)

**Location**: `apps/web-client/src/lib/modules/chat/sse-chat-transport.ts`

Custom transport that conforms to AI SDK contract using SSE:

```typescript
import type { ChatTransport, UIMessageChunk } from "ai";

export class SSEChatTransport implements ChatTransport {
  constructor(
    private apiUrl: string,
    private headers: Record<string, string> = {},
  ) {}

  async sendMessages({
    chatId,
    messages,
    abortSignal,
  }): Promise<ReadableStream<UIMessageChunk>> {
    // 1. POST message to trigger processing
    const response = await fetch(`${this.apiUrl}/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...this.headers,
      },
      body: JSON.stringify({
        id: chatId,
        message: messages[messages.length - 1].content,
      }),
      signal: abortSignal,
    });

    if (!response.ok) {
      throw new Error(`Chat request failed: ${response.statusText}`);
    }

    const { chatId: resolvedChatId, streamId } = await response.json();

    // 2. Create ReadableStream backed by SSE
    return new ReadableStream<UIMessageChunk>({
      start(controller) {
        // Connect to SSE endpoint
        const eventSource = new EventSource(
          `${this.apiUrl}/chat/${resolvedChatId}/streams/${streamId}`,
        );

        eventSource.addEventListener("message", (event) => {
          try {
            const chunk = JSON.parse(event.data) as UIMessageChunk;
            controller.enqueue(chunk);
          } catch (error) {
            console.error("Failed to parse SSE message:", error);
          }
        });

        eventSource.addEventListener("complete", () => {
          controller.close();
          eventSource.close();
        });

        eventSource.addEventListener("error", (event) => {
          console.error("SSE error:", event);
          controller.error(new Error("Stream connection failed"));
          eventSource.close();
        });

        // Handle abort signal
        abortSignal?.addEventListener("abort", () => {
          eventSource.close();
          controller.close();
        });
      },
    });
  }

  async reconnectToStream({
    chatId,
  }): Promise<ReadableStream<UIMessageChunk> | null> {
    // Check if there's an active stream for this chat
    // In production, this would query the server for active streams
    // For POC, returning null (no reconnection)
    return null;
  }
}

// Usage example:
export function useAtlasChat(initialChatId?: string) {
  const transport = new SSEChatTransport("/api", {
    "X-User-Id": userId,
    "X-Workspace-Id": workspaceId,
  });

  return useChat({
    id: initialChatId,
    transport,
    // Client configuration
    sendExtraMessageFields: false,
    keepLastMessageOnError: true,
  });
}
```

## File Changes Summary

### New Files

1. `packages/core/src/chat/storage.ts` - Chat storage with Deno KV implementation
2. `packages/core/src/chat/sse-manager.ts` - SSE stream manager for event distribution
3. `apps/atlasd/routes/chat.ts` - Chat endpoints and SSE streaming (merged)
4. `apps/web-client/src/lib/modules/chat/sse-chat-transport.ts` - AI SDK transport (frontend)

### Modified Files

1. `src/core/workspace-runtime.ts` - Accept stream callback parameter
2. `src/core/actors/session-supervisor-actor.ts` - Use CallbackStreamEmitter for chats
3. `packages/system/agents/conversation/conversation.agent.ts` - Load chat history
4. `apps/atlasd/src/atlas-daemon.ts` - Register chat routes

## Implementation Order

1. **Storage Layer** - Create ChatStorage with Deno KV
2. **SSE Manager** - Implement stream manager for event distribution
3. **Chat Endpoints** - Implement `/api/chat` to trigger processing and `/api/chat/:chatId/streams/:streamId` for SSE streaming
4. **Runtime Callback** - Modify workspace runtime for stream callbacks
5. **Session Routing** - Update session supervisor to use callbacks
6. **Agent History** - Update conversation agent to load history
7. **Frontend Transport** - Create SSE-backed transport for AI SDK

## Testing Approach

1. Unit test `ChatStorage` operations
2. Unit test `SSEStreamManager` event distribution
3. Integration test chat endpoint returns streamId
4. Integration test SSE streaming with multiple subscribers
5. E2E test: POST message, connect SSE, verify streaming
6. Test conversation agent with/without history

## Key Insights

- **Hybrid SSE approach** - POST triggers processing, SSE delivers stream
- **AI SDK compatible** - Custom transport wraps SSE in ReadableStream
- **Multi-client support** - Multiple clients can observe same stream
- **Callback routing** - Stream events flow through callbacks to SSE manager
- **Clean separation** - Session supervisor routes events via callbacks

## Architecture Benefits

- **Multi-client observation** - Multiple users can watch same chat
- **AI SDK compatibility** - Works with Vercel AI SDK's useChat hook
- **Proper chat persistence** - Messages stored in Deno KV
- **History support** - Conversation agent loads full context
- **Stream resilience** - SSE has built-in reconnection
- **Event buffering** - Late joiners receive buffered events

## Out of Scope

- Frontend/UI changes (another engineer will integrate)
- Multi-session aggregation (triggered workspaces)
- Chat search/filtering
- Message editing
- Authentication/authorization
- Stream reconnection (POC returns null)
