# Chat POC Testing Strategy

## Core Principle

Test with **real components**. No mocking. Willing to spend $ on LLM calls to verify actual product behavior.

## Assumptions

- **Daemon running on :8080** - Tests don't manage daemon lifecycle
- **Real conversation agent** - Test actual AI responses
- **Use v2 client** - `@atlas/client/v2` for type-safe API calls

## What We're Testing

1. Agent streamed chunks reach SSE clients (real LLM streaming)
2. Multiple SSE clients receive identical events
3. Transport produces correct `ReadableStream<UIMessageChunk>`
4. Messages persist (user + assistant)
5. Chat history loads correctly

## Testing Layers

### Layer 1: Unit Tests (Fast, No Daemon)

Test components in isolation:

```typescript
// packages/core/src/chat/storage.test.ts
import { expect } from "@std/expect";
import type { SessionUIMessage } from "@atlas/core";
import { ChatStorage } from "./storage.ts";

Deno.test("ChatStorage - create and retrieve chat", async () => {
  const chatId = `test-${crypto.randomUUID()}`;

  const result = await ChatStorage.createChat({
    chatId,
    userId: "test-user",
    workspaceId: "test-ws",
  });

  expect(result.ok).toBe(true);

  const retrieved = await ChatStorage.getChat(chatId);
  expect(retrieved.ok).toBe(true);
  expect(retrieved.data?.userId).toBe("test-user");
});

Deno.test("ChatStorage - append and retrieve messages", async () => {
  const chatId = `test-${crypto.randomUUID()}`;

  await ChatStorage.createChat({
    chatId,
    userId: "test-user",
    workspaceId: "test-ws",
  });

  const message: SessionUIMessage = {
    id: crypto.randomUUID(),
    role: "user",
    parts: [{ type: "text", text: "Hello" }],
  };

  const appendResult = await ChatStorage.appendMessage(chatId, message);
  expect(appendResult.ok).toBe(true);

  const messagesResult = await ChatStorage.getMessages(chatId);
  expect(messagesResult.ok).toBe(true);
  expect(messagesResult.data).toHaveLength(1);
  expect(messagesResult.data[0]?.parts[0]?.text).toBe("Hello");
});

// packages/core/src/chat/sse-manager.test.ts
import type { SessionUIMessageChunk } from "@atlas/core";
import { SSEStreamManager } from "./sse-manager.ts";

Deno.test("SSEStreamManager - multi-client distribution", () => {
  const manager = new SSEStreamManager();
  const streamId = `stream-${crypto.randomUUID()}`;
  const chatId = `chat-${crypto.randomUUID()}`;

  manager.createStream(streamId, chatId);

  const events1: SessionUIMessageChunk[] = [];
  const events2: SessionUIMessageChunk[] = [];

  manager.subscribe(streamId, (e) => events1.push(e));
  manager.subscribe(streamId, (e) => events2.push(e));

  const chunk: SessionUIMessageChunk = {
    type: "text-delta",
    data: { textDelta: "test" }
  };
  manager.emit(streamId, chunk);

  expect(events1).toHaveLength(1);
  expect(events2).toHaveLength(1);
  expect(events1[0]).toEqual(chunk);
  expect(events2[0]).toEqual(chunk);
});

Deno.test("SSEStreamManager - late joiner receives buffered events", () => {
  const manager = new SSEStreamManager();
  const streamId = `stream-${crypto.randomUUID()}`;
  const chatId = `chat-${crypto.randomUUID()}`;

  manager.createStream(streamId, chatId);

  // Emit before subscriber connects
  manager.emit(streamId, { type: "text-delta", data: { textDelta: "hello" } });
  manager.emit(streamId, { type: "text-delta", data: { textDelta: " world" } });

  // Late joiner
  const events: SessionUIMessageChunk[] = [];
  manager.subscribe(streamId, (e) => events.push(e));

  expect(events).toHaveLength(2);
});
```

### Layer 2: Integration Tests (Real Daemon, Real LLM)

**Prerequisites**:
- Daemon running on :8080
- `ANTHROPIC_API_KEY` set

```typescript
// tests/chat-integration.test.ts
import { client, parseResult } from "@atlas/client/v2";
import type { SessionUIMessageChunk } from "@atlas/core";
import { expect } from "@std/expect";
import { createEventSource } from "eventsource-client";

async function collectSSEEvents(url: string, timeoutMs = 60_000): Promise<SessionUIMessageChunk[]> {
  const eventSource = createEventSource(url);
  const chunks: SessionUIMessageChunk[] = [];
  let completed = false;

  const timeout = setTimeout(() => {
    if (!completed) {
      throw new Error("SSE collection timeout");
    }
  }, timeoutMs);

  try {
    for await (const { event, data } of eventSource) {
      if (event === "message") {
        chunks.push(JSON.parse(data));
      } else if (event === "complete") {
        completed = true;
        break;
      }
    }
  } finally {
    clearTimeout(timeout);
  }

  return chunks;
}

Deno.test({
  name: "Chat - real conversation agent streams to SSE",
  ignore: !Deno.env.get("ANTHROPIC_API_KEY"),
  async fn() {
    // POST message to trigger real conversation agent
    const postResult = await parseResult(
      client.chat.$post({
        json: { message: "Say exactly: 'integration test passed'" },
      })
    );

    expect(postResult.ok).toBe(true);
    if (!postResult.ok) throw new Error("POST failed");

    const { chatId, streamId } = postResult.data;
    expect(chatId).toBeTruthy();
    expect(streamId).toBeTruthy();

    // Connect to SSE stream
    const sseUrl = `http://localhost:8080/api/chat/${chatId}/streams/${streamId}`;
    const chunks = await collectSSEEvents(sseUrl);

    // Verify we got chunks
    expect(chunks.length).toBeGreaterThan(0);

    // Verify text-delta chunks
    const textDeltas = chunks.filter((c) => c.type === "text-delta");
    expect(textDeltas.length).toBeGreaterThan(0);

    const fullText = textDeltas
      .map((c) => c.data?.textDelta || "")
      .join("");

    expect(fullText.toLowerCase()).toContain("integration test passed");

    // Verify persistence
    const historyResult = await parseResult(
      client.chat[":chatId"].$get({ param: { chatId } })
    );

    expect(historyResult.ok).toBe(true);
    if (!historyResult.ok) throw new Error("History fetch failed");

    // Type assertion for the response data
    const historyData = historyResult.data as {
      chat: unknown;
      messages: SessionUIMessage[]
    };

    // Should have user + assistant messages
    expect(historyData.messages.length).toBeGreaterThanOrEqual(2);

    const userMsg = historyData.messages.find((m) => m.role === "user");
    const assistantMsg = historyData.messages.find((m) => m.role === "assistant");

    expect(userMsg).toBeDefined();
    expect(assistantMsg).toBeDefined();

    // Assistant message should match streamed text
    const assistantPart = assistantMsg?.parts?.[0];
    expect(assistantPart?.type).toBe("text");
    if (assistantPart?.type === "text") {
      expect(assistantPart.text.toLowerCase()).toContain("integration test passed");
    }
  },
});

Deno.test({
  name: "Chat - multiple SSE clients receive identical events",
  ignore: !Deno.env.get("ANTHROPIC_API_KEY"),
  async fn() {
    const postResult = await parseResult(
      client.chat.$post({
        json: { message: "Count: 1, 2, 3" },
      })
    );

    expect(postResult.ok).toBe(true);
    if (!postResult.ok) throw new Error("POST failed");

    const { chatId, streamId } = postResult.data;
    const sseUrl = `http://localhost:8080/api/chat/${chatId}/streams/${streamId}`;

    // Collect from two clients in parallel
    const [chunks1, chunks2] = await Promise.all([
      collectSSEEvents(sseUrl),
      collectSSEEvents(sseUrl),
    ]);

    // Both clients should receive identical events
    expect(chunks1.length).toBe(chunks2.length);
    expect(chunks1.length).toBeGreaterThan(0);

    for (let i = 0; i < chunks1.length; i++) {
      expect(chunks1[i]).toEqual(chunks2[i]);
    }
  },
});

Deno.test({
  name: "Chat - late joiner receives buffered events",
  ignore: !Deno.env.get("ANTHROPIC_API_KEY"),
  async fn() {
    const postResult = await parseResult(
      client.chat.$post({ json: { message: "Quick response" } })
    );

    expect(postResult.ok).toBe(true);
    if (!postResult.ok) throw new Error("POST failed");

    const { chatId, streamId } = postResult.data;
    const sseUrl = `http://localhost:8080/api/chat/${chatId}/streams/${streamId}`;

    // First client connects and collects some events
    const eventSource1 = createEventSource(sseUrl);
    const chunks1: SessionUIMessageChunk[] = [];

    let collected = false;
    for await (const { event, data } of eventSource1) {
      if (event === "message") {
        chunks1.push(JSON.parse(data));
        if (chunks1.length >= 3) {
          collected = true;
          break; // Disconnect after 3 events
        }
      }
    }

    expect(collected).toBe(true);

    // Second client (late joiner) connects
    const chunks2 = await collectSSEEvents(sseUrl);

    // Late joiner should have all events (buffered + new)
    expect(chunks2.length).toBeGreaterThanOrEqual(chunks1.length);

    // First N events should match
    for (let i = 0; i < chunks1.length; i++) {
      expect(chunks2[i]).toEqual(chunks1[i]);
    }
  },
});

Deno.test({
  name: "Chat - concurrent chats don't interfere",
  ignore: !Deno.env.get("ANTHROPIC_API_KEY"),
  async fn() {
    // Start two chats simultaneously
    const [post1, post2] = await Promise.all([
      parseResult(client.chat.$post({ json: { message: "Chat A" } })),
      parseResult(client.chat.$post({ json: { message: "Chat B" } })),
    ]);

    expect(post1.ok).toBe(true);
    expect(post2.ok).toBe(true);
    if (!post1.ok || !post2.ok) throw new Error("POST failed");

    const { chatId: chatId1, streamId: streamId1 } = post1.data;
    const { chatId: chatId2, streamId: streamId2 } = post2.data;

    // IDs should be unique
    expect(chatId1).not.toBe(chatId2);
    expect(streamId1).not.toBe(streamId2);

    // Collect from both streams in parallel
    const [chunks1, chunks2] = await Promise.all([
      collectSSEEvents(`http://localhost:8080/api/chat/${chatId1}/streams/${streamId1}`),
      collectSSEEvents(`http://localhost:8080/api/chat/${chatId2}/streams/${streamId2}`),
    ]);

    // Both should have received events
    expect(chunks1.length).toBeGreaterThan(0);
    expect(chunks2.length).toBeGreaterThan(0);

    // Smoke test - verify both streams completed independently
  },
});
```

### Layer 3: Transport Contract Test

Verify frontend transport works with real backend:

```typescript
// apps/web-client/src/lib/modules/chat/sse-chat-transport.test.ts
import type { SessionUIMessageChunk } from "@atlas/core";
import { expect } from "@std/expect";
import { SSEChatTransport } from "./sse-chat-transport.ts";

Deno.test({
  name: "SSEChatTransport - produces ReadableStream with real backend",
  ignore: !Deno.env.get("ANTHROPIC_API_KEY"),
  async fn() {
    const transport = new SSEChatTransport("http://localhost:8080/api");

    const stream = await transport.sendMessages({
      chatId: undefined,
      messages: [{ role: "user", content: "Test transport" }],
      abortSignal: new AbortController().signal,
    });

    expect(stream).toBeInstanceOf(ReadableStream);

    const reader = stream.getReader();
    const chunks: SessionUIMessageChunk[] = [];

    let done = false;
    let iterations = 0;
    const maxIterations = 1000;

    while (!done && iterations < maxIterations) {
      const { value, done: streamDone } = await reader.read();
      if (value) chunks.push(value);
      done = streamDone;
      iterations++;
    }

    // Verify chunks match UIMessageChunk type
    expect(chunks.length).toBeGreaterThan(0);

    // Check for text-delta chunks
    const textChunk = chunks.find((c) => c.type === "text-delta");
    expect(textChunk).toBeDefined();
    expect(textChunk?.data).toHaveProperty("textDelta");
    expect(typeof textChunk?.data?.textDelta).toBe("string");
  },
});
```

## Message Persistence Architecture

**AI SDK Pattern** (from docs):
1. Load messages from storage
2. Pass to streamText
3. In onFinish, persist full messages array (includes new assistant message)

**Current Issue**:
- Chat route persists user message
- Conversation agent loads history by `streamId` instead of `chatId`
- Conversation agent's onFinish doesn't persist

**Correct Flow**:

```typescript
// apps/atlasd/routes/chat.ts (SIMPLIFIED)
chatRoutes.post("/", async (c) => {
  // 1. Create/retrieve chat
  const chatId = /* ... */;

  // 2. Store user message
  await ChatStorage.appendMessage(chatId, userMessage);

  // 3. Create stream
  const streamId = crypto.randomUUID();
  sseManager.createStream(streamId, chatId);

  // 4. Trigger agent with chatId in payload
  runtime.triggerSignalWithSession(
    "conversation-stream",
    { chatId, message, userId }, // chatId passed to agent
    streamId,
    (event) => sseManager.emit(streamId, event), // Just forward chunks
  )
  .then(() => sseManager.completeStream(streamId));

  return c.json({ chatId, streamId });
});

// packages/system/agents/conversation/conversation.agent.ts
handler: async (prompt, { session, stream }) => {
  // 1. Extract chatId from payload (NOT streamId!)
  const chatId = session.metadata?.chatId || session.streamId;

  // 2. Load history by chatId
  const res = await client.chat[":chatId"].$get({
    param: { chatId }
  });

  const messages: AtlasUIMessage[] = res.data?.messages || [];

  // 3. Add current message
  messages.push({
    id: crypto.randomUUID(),
    role: "user",
    parts: [{ type: "text", text: prompt }],
  });

  // 4. Stream with onFinish persistence
  const result = streamText({
    model: anthropic("claude-sonnet-4-5"),
    messages: convertToModelMessages(messages),
    // ...
  });

  await pipeUIMessageStream(
    result.toUIMessageStream({
      originalMessages: messages,
      onFinish: async ({ messages: finalMessages }) => {
        // 5. Persist ONLY new assistant message
        const assistantMsg = finalMessages[finalMessages.length - 1];
        if (assistantMsg?.role === "assistant") {
          await ChatStorage.appendMessage(chatId, assistantMsg);
        }
      },
    }),
    stream,
  );
}
```

**Key Changes**:
1. Chat route passes `chatId` in signal payload
2. Conversation agent reads `chatId` from `session.metadata`
3. Conversation agent loads history by `chatId` (not `streamId`)
4. Conversation agent persists assistant message in `onFinish`
5. StreamCollector just forwards chunks (no persistence logic)

## Test Execution

```bash
# Unit tests (no daemon needed)
deno test packages/core/src/chat/storage.test.ts
deno test packages/core/src/chat/sse-manager.test.ts

# Integration tests (daemon must be running on :8080)
ANTHROPIC_API_KEY=xxx deno test tests/chat-integration.test.ts

# Transport test (daemon + API key)
ANTHROPIC_API_KEY=xxx deno test apps/web-client/src/lib/modules/chat/sse-chat-transport.test.ts
```

## What We're Actually Testing

### ✅ Real Components
- Real Deno KV storage
- Real SSE over HTTP
- Real daemon on :8080
- Real conversation agent
- Real LLM responses (Claude)
- Real streaming behavior
- Real persistence
- Real multi-client distribution

### 🚫 Not Mocked
- No test agents
- No daemon lifecycle management
- No LLM mocks
- No simulated streaming

## Edge Cases

```typescript
Deno.test("Chat - handles invalid chatId", async () => {
  const res = await fetch(
    "http://localhost:8080/api/chat/invalid-123/streams/invalid-456"
  );
  expect(res.status).toBe(404);
});

Deno.test("Chat - handles malformed POST body", async () => {
  const res = await fetch("http://localhost:8080/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ invalid: "no message field" }),
  });
  expect(res.ok).toBe(false);
});
```

## Verification Checklist

- [ ] Unit: Storage create/retrieve chat
- [ ] Unit: Storage append/retrieve messages
- [ ] Unit: SSEManager multi-client distribution
- [ ] Unit: SSEManager late joiner buffering
- [ ] Integration: Real agent streams to SSE
- [ ] Integration: Multiple clients get identical events
- [ ] Integration: Late joiner receives buffered events
- [ ] Integration: Concurrent chats isolated
- [ ] Integration: Assistant message persists (via onFinish)
- [ ] Integration: Chat history loads correctly
- [ ] Transport: ReadableStream contract
- [ ] Edge cases: Error handling, invalid inputs

## Summary

Simple HTTP integration tests against real daemon. Use real LLM. Verify actual product behavior.

**Persistence follows AI SDK pattern**: Agent's `onFinish` callback persists assistant message to chat storage.

80/20: Focus on end-to-end flow with real components.
