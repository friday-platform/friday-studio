# Chat Stream Resumption

**PR:** #1507
**Merged:** 2026-01-20
**Status:** Complete

## What Changed

Users no longer lose partial responses when refreshing the page or navigating away during an agent response. The server buffers events in memory, and clients can reconnect to receive the full replay plus live events.

## The Core Insight

**Decouple "HTTP connection closed" from "cancel the work."**

Browsers abort fetch requests on tab close/refresh—that's unavoidable. Previously, this meant lost events. Now:
- Agent keeps running server-side regardless of client connection state
- Events buffer in memory (StreamRegistry)
- Reconnecting clients receive replay + live stream
- Stop button is a separate explicit action (DELETE call)

## Architecture

### Server: StreamRegistry (`apps/atlasd/src/stream-registry.ts`)

In-memory event buffer per chat. Key operations:

| Method | Behavior |
|--------|----------|
| `createStream(chatId)` | Initialize buffer. Cancels any existing stream for same chatId. |
| `appendEvent(chatId, event)` | Buffer event + broadcast to all subscribers |
| `subscribe(chatId, controller)` | Replay full buffer, then add to broadcast list |
| `finishStream(chatId)` | Mark inactive, close all subscribers |

Constants:
- `MAX_EVENTS = 1000` (overflow → stream finished, agent continues unbuffered)
- Cleanup: 5min after finished, 30min if stale

### Endpoints

| Endpoint | Purpose |
|----------|---------|
| `POST /api/chat` | Creates stream, buffers all events, finishes in finally block |
| `GET /api/chat/:chatId/stream` | Reconnect: 200 with SSE (replay + live) or 204 if no active stream |
| `DELETE /api/chat/:chatId/stream` | Cosmetic stop (idempotent) |

### Client: Unified Route (`/chat/[[chatId]]`)

Single SvelteKit route with optional param handles both new and existing chats:
- New chats: generate ID client-side (`nanoid()`), URL updates via `replaceState` after first response
- Existing chats: `chat.resumeStream()` on mount attempts reconnection
- Chat instances are page-local, not context-managed

## Key Decisions

| Decision | Choice | Why |
|----------|--------|-----|
| Buffer key | `chatId` | One active stream per chat, new message cancels previous |
| Replay scope | Full buffer | No sequence tracking needed—simpler |
| Stop behavior | Cosmetic | Real agent cancellation deferred (requires FSM abort signal plumbing) |
| Chat instances | Page-local | Simpler lifecycle than context-managed |
| New chat ID | Client-generated | Available immediately for optimistic navigation |

## Gotchas for Future Work

**SSE connection leak (fixed):** The ai-sdk's `reconnectToStream` doesn't accept AbortSignal. We inject our own AbortController via fetch wrapper and abort in `beforeNavigate`. Without this, each navigation leaks an HTTP connection. See commit `e86d8f7`.

**Turn timer persistence:** Server sends `X-Turn-Started-At` header on GET reconnect so client can show accurate elapsed time. Header must be in CORS `Access-Control-Expose-Headers`. See commit `f16647c`.

**Multi-tab:** Explicitly not supported. Multiple tabs hitting same stream works (multiple subscribers) but there's no cross-tab state sync.

## Known Limitations

- **Memory-only:** Buffers lost on daemon restart
- **Cosmetic stop:** Agent continues running after stop button
- **Single-tab focus:** Multi-tab sync is a non-goal

## Deferred Work

1. **Real agent cancellation** - Requires FSM abort signal plumbing
2. **Daemon restart resilience** - Would need persistent storage (Redis/disk)
3. **Multi-tab sync** - Would need shared state mechanism or SSE broadcast
4. **Stop UX** - Should we indicate "agent still running in background"?

## Files

**Server:**
- `apps/atlasd/src/stream-registry.ts` - Buffer implementation
- `apps/atlasd/routes/chat.ts` - Endpoints

**Client:**
- `apps/web-client/src/routes/(app)/chat/[[chatId]]/` - Unified route
- `apps/web-client/src/lib/chat-context.svelte.ts` - Simplified to sidebar-only

**Tests:**
- `apps/atlasd/src/stream-registry.test.ts` - Unit tests for buffer behavior
