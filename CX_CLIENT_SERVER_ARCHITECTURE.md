# CX Client-Server Architecture Design

## Problem Statement

The current `cx-dev` command violates Atlas architecture by:

1. **Direct LLM calls** in CLI instead of going through daemon API
2. **Tight coupling** between UI and business logic
3. **No real-time streaming** for chat-like experience
4. **Bypassing Atlas infrastructure** (no workspace integration, no session management)

## Proposed Architecture

### Multi-Client Session Management

**Current: 1 Terminal = 1 Session (Claude Code style)**

```
┌─────────────┐    GET /sessions/{sessionId}/stream    ┌──────────────┐
│ CLI Client  ├─────────────────────────────────────►│  Session A   │
│  (User A)   │◄─────────────────────────────────────┤  (Private)   │
└─────────────┘                                       └──────────────┘

┌─────────────┐    GET /sessions/{sessionId}/stream    ┌──────────────┐
│ CLI Client  ├─────────────────────────────────────►│  Session B   │
│  (User B)   │◄─────────────────────────────────────┤  (Private)   │
└─────────────┘                                       └──────────────┘
```

**Future: Multiple Humans = Shared Session (Chatroom style)**

```
┌─────────────┐    GET /sessions/{sessionId}/stream    ┌──────────────┐
│ CLI Client  ├─────────────────────────────────────►│              │
│  (User A)   │◄─────────────────────────────────────┤  Session X   │
└─────────────┘                                       │  (Shared)    │
                                                      │              │
┌─────────────┐    GET /sessions/{sessionId}/stream    │              │
│ CLI Client  ├─────────────────────────────────────►│              │
│  (User B)   │◄─────────────────────────────────────┤              │
└─────────────┘                                       └──────────────┘
```

### Client-Server Split

```
┌─────────────────┐    SSE/HTTP     ┌──────────────────┐    Native Tools    ┌─────────────────┐
│   CX CLI View   │ ◄────────────► │   Atlas Daemon   │ ◄──────────────► │ ConversationSup │
│  (Dumb Client)  │                │  (Smart Server)  │                   │    (LLM+Tools)  │
└─────────────────┘                └──────────────────┘                   └─────────────────┘
```

### Client Responsibilities (CLI)

- **Render chat interface** (TUI with Ink)
- **Send user messages** via HTTP POST
- **Receive responses** via Server-Sent Events (SSE)
- **Display typing indicators** and real-time updates
- **Handle connection state** (connecting, connected, disconnected)

### Server Responsibilities (Daemon)

- **ConversationSupervisor integration** with Atlas workspace context
- **Message processing** with native tool calling
- **Streaming responses** via SSE for real-time feel
- **Session management** within Atlas workspace
- **Transparency envelope** processing and formatting

## API Design

### 1. Conversation Session Endpoint

```http
POST /api/workspaces/{workspaceId}/conversation/sessions
Content-Type: application/json

{
  "mode": "private",  // "private" or "shared" (future)
  "metadata": {
    "userId": "user123",
    "clientType": "atlas-cli",
    "capabilities": ["streaming", "transparency"]
  }
}

Response:
{
  "sessionId": "conv_abc123",
  "mode": "private",
  "participants": [{"userId": "user123", "joinedAt": "2025-06-30T02:30:00Z"}],
  "sseUrl": "/api/workspaces/{workspaceId}/conversation/sessions/conv_abc123/stream"
}
```

### 2. Send Message Endpoint

```http
POST /api/workspaces/{workspaceId}/conversation/sessions/{sessionId}/messages
Content-Type: application/json

{
  "message": "Help me review my authentication code for security issues",
  "fromUser": "user123",
  "timestamp": "2025-06-30T02:30:00Z"
}

Response:
{
  "messageId": "msg_def456",
  "status": "processing"
}
```

### 3. Real-time Stream (SSE)

```http
GET /api/workspaces/{workspaceId}/conversation/sessions/{sessionId}/stream
Accept: text/event-stream

Response Stream:
event: thinking
data: {"status": "processing", "message": "Analyzing your request...", "fromUser": "user123"}

event: tool_call
data: {"toolName": "atlas_reply", "args": {...}, "messageId": "msg_def456"}

event: message_chunk
data: {"content": "I'll help you review your authentication code", "partial": true, "messageId": "msg_def456"}

event: transparency
data: {"analysis": "...", "confidence": 0.8, "complexity": "high", "requiresAgentCoordination": true, "messageId": "msg_def456"}

event: orchestration
data: {"sessionId": "sess_xyz", "agents": ["security-agent", "code-reviewer"], "strategy": "parallel", "messageId": "msg_def456"}

event: message_complete
data: {"messageId": "msg_def456", "complete": true}

// Future: Multi-user events
event: user_message
data: {"content": "Can you also check the auth module?", "fromUser": "user456", "messageId": "msg_789", "timestamp": "2025-06-30T02:31:00Z"}

event: user_joined
data: {"userId": "user789", "username": "alice", "timestamp": "2025-06-30T02:31:00Z"}
```

### 4. Future: Join Existing Session API

```http
POST /api/workspaces/{workspaceId}/conversation/sessions/{sessionId}/join
Content-Type: application/json

{
  "userId": "user456",
  "clientType": "atlas-cli"
}

Response:
{
  "sessionId": "conv_abc123",
  "participants": [
    {"userId": "user123", "joinedAt": "2025-06-30T02:30:00Z"},
    {"userId": "user456", "joinedAt": "2025-06-30T02:31:00Z"}
  ],
  "sseUrl": "/api/workspaces/{workspaceId}/conversation/sessions/conv_abc123/stream"
}
```

## Implementation Plan

### Phase 1: Single User Sessions (Current Need)

- 1 terminal = 1 private session
- Simple session management with future-ready data structures
- Basic SSE streaming with user attribution

### Phase 2: Multi-User Foundation (Design Now, Implement Later)

- Session participant management
- User identification in all events
- Message attribution and history
- Join/leave mechanics for shared sessions

### Phase 3: Server-Side API Implementation

#### 1. Add ConversationSupervisor to Daemon

```typescript
// src/core/conversation-supervisor.ts
export class ConversationSupervisor {
  constructor(
    private workspaceId: string,
    private workspaceContext: WorkspaceContext,
  ) {}

  async processMessage(message: string): Promise<AsyncIterableIterator<ConversationEvent>> {
    // Use native tool calling with workspace context
    // Stream results via async iterator
  }
}
```

#### 2. Add Conversation Routes to AtlasDaemon

```typescript
// src/core/atlas-daemon.ts - add to setupRoutes()

// Create conversation session
this.app.post("/api/workspaces/:workspaceId/conversation/sessions", async (c) => {
  const workspaceId = c.req.param("workspaceId");
  const body = await c.req.json();

  // Create conversation session with workspace context
  const sessionId = await this.createConversationSession(workspaceId, body);

  return c.json({
    sessionId,
    sseUrl: `/api/workspaces/${workspaceId}/conversation/sessions/${sessionId}/stream`,
  });
});

// Send message
this.app.post(
  "/api/workspaces/:workspaceId/conversation/sessions/:sessionId/messages",
  async (c) => {
    const { workspaceId, sessionId } = c.req.param();
    const { message } = await c.req.json();

    const messageId = await this.processConversationMessage(workspaceId, sessionId, message);

    return c.json({ messageId, status: "processing" });
  },
);

// SSE stream
this.app.get("/api/workspaces/:workspaceId/conversation/sessions/:sessionId/stream", async (c) => {
  return this.streamConversationEvents(c, workspaceId, sessionId);
});
```

#### 3. SSE Streaming Implementation

```typescript
// src/core/conversation-streaming.ts
export interface ConversationEvent {
  type:
    | "thinking"
    | "tool_call"
    | "message_chunk"
    | "transparency"
    | "orchestration"
    | "message_complete";
  data: any;
  timestamp: string;
}

export class ConversationStreamer {
  async *streamConversationResponse(
    supervisor: ConversationSupervisor,
    message: string,
  ): AsyncIterableIterator<ConversationEvent> {
    yield { type: "thinking", data: { status: "processing" }, timestamp: new Date().toISOString() };

    // Stream native tool calling results
    const result = await supervisor.processMessage(message);

    for await (const event of result) {
      yield event;
    }
  }
}
```

### Phase 2: Client-Side Refactor (Day 2)

#### 1. Create Daemon Client for Conversations

```typescript
// src/cli/utils/conversation-client.ts
export class ConversationClient {
  constructor(private daemonUrl: string, private workspaceId: string) {}

  async createSession(): Promise<{ sessionId: string; sseUrl: string }> {
    const response = await fetch(
      `${this.daemonUrl}/api/workspaces/${this.workspaceId}/conversation/sessions`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "interactive" }),
      },
    );

    return await response.json();
  }

  async sendMessage(sessionId: string, message: string): Promise<{ messageId: string }> {
    const response = await fetch(
      `${this.daemonUrl}/api/workspaces/${this.workspaceId}/conversation/sessions/${sessionId}/messages`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, timestamp: new Date().toISOString() }),
      },
    );

    return await response.json();
  }

  async *streamEvents(sessionId: string): AsyncIterableIterator<ConversationEvent> {
    const sseUrl =
      `${this.daemonUrl}/api/workspaces/${this.workspaceId}/conversation/sessions/${sessionId}/stream`;

    const eventSource = await createEventSource({ url: sseUrl });

    for await (const message of eventSource.consume()) {
      yield {
        type: message.event as any,
        data: JSON.parse(message.data),
        timestamp: new Date().toISOString(),
      };
    }
  }
}
```

#### 2. Refactor CX CLI to be Dumb Client

```typescript
// src/cli/commands/cx.tsx (new file - replace cx-dev.tsx)
export function CxCommand() {
  const [conversationClient, setConversationClient] = useState<ConversationClient | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [isConnected, setIsConnected] = useState(false);

  // Initialize connection to daemon
  useEffect(() => {
    initializeConversation();
  }, []);

  const initializeConversation = async () => {
    try {
      // Get workspace context from current directory
      const workspaceId = await detectWorkspaceId();
      const client = new ConversationClient("http://localhost:8080", workspaceId);

      // Create conversation session
      const session = await client.createSession();

      setConversationClient(client);
      setSessionId(session.sessionId);
      setIsConnected(true);

      // Start listening to SSE stream
      startEventStream(client, session.sessionId);
    } catch (error) {
      setMessages((prev) => [...prev, {
        type: "error",
        content: `Failed to connect to Atlas daemon: ${error.message}`,
      }]);
    }
  };

  const startEventStream = async (client: ConversationClient, sessionId: string) => {
    try {
      for await (const event of client.streamEvents(sessionId)) {
        handleConversationEvent(event);
      }
    } catch (error) {
      setIsConnected(false);
      setMessages((prev) => [...prev, {
        type: "error",
        content: `Connection lost: ${error.message}`,
      }]);
    }
  };

  const handleConversationEvent = (event: ConversationEvent) => {
    switch (event.type) {
      case "thinking":
        setMessages((prev) => [...prev, {
          type: "system",
          content: "🤔 ConversationSupervisor is thinking...",
        }]);
        break;

      case "message_chunk":
        // Update current message with new content
        setMessages((prev) => {
          const newMessages = [...prev];
          const lastMessage = newMessages[newMessages.length - 1];

          if (lastMessage?.type === "assistant" && lastMessage.partial) {
            lastMessage.content += event.data.content;
          } else {
            newMessages.push({
              type: "assistant",
              content: event.data.content,
              partial: true,
            });
          }

          return newMessages;
        });
        break;

      case "transparency":
        setMessages((prev) => [...prev, {
          type: "transparency",
          content: event.data,
        }]);
        break;

      case "orchestration":
        setMessages((prev) => [...prev, {
          type: "orchestration",
          content: event.data,
        }]);
        break;

      case "message_complete":
        setMessages((prev) => {
          const newMessages = [...prev];
          const lastMessage = newMessages[newMessages.length - 1];
          if (lastMessage?.partial) {
            lastMessage.partial = false;
          }
          return newMessages;
        });
        break;
    }
  };

  const sendMessage = async (message: string) => {
    if (!conversationClient || !sessionId) return;

    // Add user message immediately
    setMessages((prev) => [...prev, {
      type: "user",
      content: message,
    }]);

    // Send to daemon (response will come via SSE)
    await conversationClient.sendMessage(sessionId, message);
  };

  return (
    <Box flexDirection="column" padding={1}>
      {/* Connection status */}
      <ConnectionStatus isConnected={isConnected} />

      {/* Message history */}
      <MessageHistory messages={messages} />

      {/* Input */}
      <MessageInput onSend={sendMessage} disabled={!isConnected} />
    </Box>
  );
}
```

### Phase 3: Enhanced Features (Day 3)

#### 1. Typing Indicators

```typescript
// Show real-time typing indicators during processing
event: typing_start
data: {"status": "ConversationSupervisor is analyzing your request..."}

event: typing_update  
data: {"status": "Coordinating security-agent and code-reviewer..."}

event: typing_stop
data: {}
```

#### 2. Message History Persistence

```typescript
// Store conversation history in workspace context
// Allow resuming conversations across CLI restarts
```

#### 3. Workspace Integration

```typescript
// Use actual workspace context (agents, jobs, signals)
// Show available agents and jobs in conversation
// Enable triggering real Atlas workflows from conversation
```

## Technical Benefits

### 1. Proper Architecture

- **Separation of concerns**: UI vs business logic
- **Atlas integration**: Full workspace context and supervision
- **API consistency**: All operations go through daemon
- **Scalability**: Multiple clients can connect to same daemon

### 2. Real-time Experience

- **Streaming responses**: Chat-like feel with SSE
- **Typing indicators**: Visual feedback during processing
- **Progressive enhancement**: Show transparency data as it becomes available
- **Connection resilience**: Automatic reconnection and error handling

### 3. Atlas Platform Benefits

- **Session management**: Conversations are Atlas sessions
- **Workspace context**: Access to real agents, jobs, signals
- **Supervision hierarchy**: Quality control through Atlas supervisors
- **Auditability**: All conversations logged and traceable

## Migration Strategy

### Backward Compatibility

- Keep `cx-dev` command during transition
- Add new `cx` command with client-server architecture
- Feature flag to enable/disable new architecture
- Gradual migration path for users

### Testing Strategy

- Unit tests for conversation API endpoints
- Integration tests for SSE streaming
- End-to-end tests for CLI client
- Performance tests for real-time responsiveness

## Success Metrics

### Technical Metrics

- **Response latency**: <100ms for first SSE event
- **Streaming performance**: Real-time feel with progressive updates
- **Connection reliability**: Automatic reconnection on failures
- **Memory efficiency**: Proper cleanup of SSE connections

### User Experience Metrics

- **Chat-like feel**: Immediate feedback and streaming responses
- **Transparency**: Rich reasoning data displayed progressively
- **Atlas integration**: Access to workspace agents and jobs
- **Reliability**: Consistent performance across different environments

This architecture properly separates the dumb CLI client from the smart daemon server while
providing a real-time chat experience through SSE streaming.
