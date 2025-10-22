# SSE Chat Transport: Resumption & Cancellation Strategy

## Problem Statement

Eric asked to analyze the SSE chat transport implementation (`apps/web-client/src/lib/modules/chat/sse-chat-transport.ts`) and propose how to add both **resumption** and **cancellation** capabilities while working within the constraints of the AI SDK's ChatTransport interface.

Reference: https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-resume-streams

### Key Constraints

- Must work within AI SDK's ChatTransport interface (no breaking changes)
- Don't want to add scaffolding/wrappers around the Chat primitive
- Keep it simple and integrated with existing architecture

## Current Architecture Analysis

### What's Working

- Server buffers events in `sseManager` with 10s grace period
- Supports `Last-Event-ID` header for SSE reconnection (standard pattern)
- Client has AbortSignal plumbing for cancellation
- Storage layer persists messages (source of truth)

### Gaps Identified

1. `reconnectToStream()` returns null - not implemented
2. No client-side persistence of chatId/lastEventId for reconnection
3. AbortSignal only stops client stream, server session continues running
4. No way to check if stream still exists server-side

## Proposed Solution

### 1. Resumption Strategy

**Key Insight**: SSE is actually better than streamable HTTP for this use case because events are buffered server-side and Last-Event-ID is a standard reconnection pattern.

**Implementation**:

```typescript
// In SSEChatTransport class
async reconnectToStream(
  options: { chatId: string } & ChatRequestOptions,
): Promise<ReadableStream<AtlasUIMessageChunk> | null> {
  // Check if stream exists server-side
  const testUrl = `${this.apiUrl}/chat/${options.chatId}/stream`;

  try {
    const resp = await fetch(testUrl, { method: 'HEAD' });
    if (resp.status === 204) return null; // Stream gone

    // Stream exists - reconnect with last event ID
    const lastEventId = localStorage.getItem(`chat-${options.chatId}-lastEvent`);
    return this.createSSEStream(options.chatId, undefined, lastEventId);
  } catch {
    return null;
  }
}
```

**Event Tracking**:

- Store event IDs in localStorage during streaming
- Pass Last-Event-ID header when reconnecting
- Server resumes from that point (already supported)

### 2. Cancellation Strategy

**Implementation**:

```typescript
// Enhanced abort handling in sendMessages
if (options.abortSignal) {
  options.abortSignal.addEventListener(
    "abort",
    async () => {
      // Tell server to stop session
      await fetch(`${this.apiUrl}/chat/${chatId}/abort`, {
        method: "POST",
      }).catch(() => {}); // Fire and forget
    },
    { once: true },
  );
}
```

**Server-side endpoint**:

```typescript
.post("/:chatId/abort", async (c) => {
  const chatId = c.req.param("chatId");
  const runtime = await ctx.getWorkspaceRuntime(workspaceId);
  runtime.cancelSession(chatId);
  sseManager.completeStream(chatId);
  return c.json({ aborted: true });
})
```

### 3. Why This Works Without Breaking Interface

1. **`reconnectToStream`** - Already part of ChatTransport interface, just needs implementation
2. **AbortSignal** - Already passed through, we just enhance its behavior
3. **localStorage** - Client-side state persistence, invisible to AI SDK
4. **Server endpoints** - Additive changes only (new `/abort` endpoint)
5. **AI SDK Chat component** - Handles reconnection automatically when implemented

## Eric's Feedback

Eric wants to proceed with this approach because:

- Stays within ChatTransport interface constraints
- No wrapper components or custom hooks needed
- Works seamlessly with AI SDK's Chat primitive
- Minimal changes to existing code

## Implementation Status

- Server now accepts full AtlasUIMessage instead of just text (fixed)
- Ready to implement reconnectToStream() properly
- Need to add abort endpoint on server
- Need to add event ID tracking in client

## Edge Cases to Handle

1. **Partial chunks during disconnect** - Buffer incomplete chunks client-side
2. **Session completes while offline** - Stream returns 204, load from storage
3. **Race condition on reconnect during teardown** - Check stream state first
4. **Memory leak prevention** - TTL on disconnected streams (already 10s)

## Next Steps

1. Implement `reconnectToStream()` method properly
2. Add server `/abort` endpoint
3. Add localStorage event tracking
4. Test reconnection scenarios
5. Test cancellation flow
