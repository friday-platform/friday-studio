# Session History v2

Shipped on `eric/planner-graph-prototype`. Encompasses three features: streaming
agent blocks, AI session summaries, and session progress visibility (pending
blocks).

The old session history system batch-persisted events after completion, had no
live streaming, and relied on a heavy server-side digest builder. Session History
v2 replaces it with a streaming-first approach: active sessions stream agent
execution blocks via SSE in real-time, completed sessions are served as JSON, and
a shared reducer builds `SessionView` on both client and server.

## What Changed

### Core Types & Reducer (`packages/core/src/session/`)

New session module with Zod-validated types and a pure reducer function.

**Event types** — Flat discriminated union of durable events:
`session:start`, `step:start`, `step:complete`, `session:complete`,
`session:summary`. Plus transient `EphemeralChunk` (never persisted). Events
defined as Zod schemas in `session-events.ts`.

**Reducer** (`session-reducer.ts`) — Pure function
`(SessionView, SessionStreamEvent | EphemeralChunk) → SessionView`. Used by
the client (TanStack `streamedQuery`), server (JSON endpoint), and
finalization (pre-computed summaries). Single source of truth for how events
become a session view.

**AgentBlock** — The core rendering unit. Status union:
`"pending" | "running" | "completed" | "failed" | "skipped"`. `stepNumber` is
optional (undefined for pending blocks). Each block carries agent name, action
type, task, tool call summaries, reasoning, output, and transient ephemeral
chunks.

**SessionView** — Full session state with `agentBlocks`, `aiSummary`, status,
timing. **SessionSummary** — Lightweight subset for list queries (step count,
agent names, no tool call details).

**Event emission mapper** (`event-emission-mapper.ts`) — Maps FSM engine
events to session stream events. Only `agent` and `llm` action types produce
step events; `code`/`emit` actions are filtered out.

### Planned Steps (`packages/core/src/session/planned-steps.ts`)

Pure function `extractPlannedSteps(definition)` traverses the FSM graph from
initial state, following `ADVANCE` transitions (or first key fallback), collecting
agent/LLM entry actions. Cycle detection via visited set. Returns
`Array<{ agentName: string }>` in traversal order.

Workspace-runtime enriches with human-readable `task` descriptions from agent
config, then includes `plannedSteps` on the `session:start` event. Reducer seeds
pending blocks; `step:start` matches by first-unmatched-by-name; unmatched
pending blocks become "skipped" on `session:complete`.

### Storage Adapters (`packages/core/src/session/`)

Follows the existing artifact storage pattern:

- **`SessionHistoryAdapter`** interface — `save()`, `get()`, `listByWorkspace()`
- **`LocalSessionHistoryAdapter`** — JSONL append-only for events + `metadata.json`
  for pre-computed summaries. Stored in `~/.atlas/sessions-v2/`
- **`CortexSessionHistoryAdapter`** — Single PUT on finalization, GET for reads
- **`SessionHistoryStorage`** facade — Environment-based adapter selection
  (`CORTEX_URL` present → cortex, absent → local)

### Streaming Infrastructure (`apps/atlasd/src/`)

- **`SessionEventStream`** — Per-session in-memory event buffer + SSE subscriber
  management. Full replay on connect. `emit()` for durable events (buffer +
  broadcast + JSONL append), `emitEphemeral()` for transient chunks (broadcast
  only, carries `stepNumber` for block correlation). `finalize()` persists via
  adapter and starts TTL cleanup.

- **`SessionStreamRegistry`** — Owns `SessionEventStream` lifecycle. `create()`,
  `get()`, `listActive()`, TTL eviction (5 min finalized, 30 min stale active).
  Singleton on daemon app context.

### Event Emission (`src/core/workspace-runtime.ts`)

The existing `onEvent` callback maps FSM events to session events inline.
`session:start` emits before `engine.signal()` with `plannedSteps`.
`session:complete` emits in the `finally` block. Agent results flow via a
side-channel `Map<string, AgentResult>` — the runtime stores results before the
FSM engine fires the completion event, then the callback looks them up by
execution ID.

Separate typed channels: `onEvent` for FSM lifecycle events, `onStreamEvent`
for agent UIMessageChunks (eliminated double `as unknown` cast).

### AI Summary (`src/core/session-summarizer.ts`)

`generateSessionSummary()` calls Haiku `generateObject` at session finalization.
Input: condensed step list with task descriptions + full last block output +
session status. Output: structured `{ summary, keyDetails }` with optional URLs.
5-second AbortSignal timeout, `maxTokens: 300`. Graceful fallback on any error.

Emits `session:summary` event AFTER `session:complete` — live SSE clients see
completion immediately, then summary arrives 1-3s later.

### API Routes (`apps/atlasd/routes/sessions/`)

Consolidated from 3 route modules to 1 canonical `/api/sessions`.

- **`GET /api/sessions/:id/stream`** (SSE) — Active sessions: full replay +
  live. Recently-finalized (still in registry): full replay + close. Old format:
  410. Unknown: 404.
- **`GET /api/sessions/:id`** (JSON) — Completed sessions: full `SessionView`.
  Active: snapshot from buffer. Old format: 410.
- **`GET /api/sessions/history/`** — Pre-computed `SessionSummary` list. Active
  sessions get live summaries from registry.

### Web Client (`apps/web-client/`)

- **`AgentBlockCard`** component — Renders all block statuses: pending (dimmed,
  non-interactive with agent description subtitle), running (auto-expanded with
  ephemeral indicators), completed/failed (collapsible detail), skipped (dimmed
  with "Skipped" label).
- **Session detail page** — TanStack `streamedQuery` for active sessions, regular
  `queryFn` for completed. `query.isFetching` as live indicator. AI summary
  section between status header and agent blocks (loading skeleton while
  generating, hidden if absent).
- **SSE consumer** (`session-event-stream.ts`) — Async generator yielding parsed
  events. Handles named `event: ephemeral` vs default events. Retry with
  exponential backoff (1s/2s/4s, max 3 attempts).
- Session list pages rewired to v2 history endpoint.

### Deleted

- `build-session-digest.ts`, `fsm-event-mapper.ts`, `history-storage.ts`
- `SessionDigestResponse` type
- `session-timeline/` components (TimelineMain, StepCard)
- Old v1 session history code

## Key Decisions

**Flat event model over nested.** Four durable event types + one transient.
No intermediate `step:tool-call` events — tool calls are bundled in
`step:complete` because agent execution completes atomically.

**Side-channel for agent results.** FSM engine fires "action X completed"
without knowing what tool calls or reasoning tokens are. Workspace-runtime
maintains a `Map<string, AgentResult>` keyed by execution ID. Keeps the FSM
engine general-purpose.

**Shared reducer in `@atlas/core`.** Same pure function on client and server.
Prevents logic divergence between server-rendered summaries and client-streamed
views.

**Pre-computed summaries.** `finalize()` reduces events once, writes summary to
adapter. List endpoint reads summaries — never reduces events at query time.

**Full replay on SSE connect, no sequence IDs.** Subscriber gets all buffered
durable events immediately, then live. No deduplication needed. Recently-finalized
sessions served from buffer (eliminates race between list fetch and SSE connect).

**Agent-only step filtering.** Only `agent` and `llm` action types produce step
events. `code`/`emit` actions are internal FSM plumbing — filtered out of
session history.

**`session:summary` after `session:complete`.** Live clients see completion
status immediately, summary arrives 1-3s later. Only approach that works without
requiring page refresh.

**Pending blocks from FSM graph traversal.** `extractPlannedSteps` follows the
happy path (ADVANCE transitions). Skipped branches become "skipped" blocks on
completion. `stepNumber` optional on blocks — pending blocks use undefined,
preventing accidental ephemeral routing.

**Array index keying for blocks.** `stepNumber` can't be used as Svelte `{#each}`
key because pending blocks share `undefined`. Array position is authoritative —
blocks are never reordered.

**Clean break from v1.** Old format sessions return 410 Gone. No migration.

## Error Handling

- **AI summary failure** — Try/catch wrapped. Timeout, API error, or parse error
  logs a warning and continues finalization without summary. Never blocks session
  completion.
- **Cortex finalization failure** — Session data lost (no incremental writes to
  cortex). Acceptable for now — session history is debugging data.
- **SSE disconnection** — Client retries with exponential backoff (3 attempts).
  Server replays full buffer on reconnect, reducer rebuilds from scratch.
- **Old format sessions** — 410 Gone from all endpoints. Disappear from list.
- **FSM document restore errors** — Warn instead of throw (prevents crash on
  malformed state).

## Out of Scope

- **Streamed intermediate tool calls** — Individual tool call events during LLM
  execution. Event structure supports adding them later.
- **Cancellation UI** — Canceling a running session from the history page.
- **Daemon restart recovery** — Resuming partial sessions from JSONL after restart.
  Data is there; surfacing it is a follow-up.
- **`do_task` streaming** — Batch path in `fsm-executor-direct.ts`.
- **Session search/filtering** — Advanced list filtering beyond workspace scoping.
- **Conversation session streaming** — System workspace FSM uses existing chat
  streaming path.
- **Cortex finalization retry** — Retry/backoff for failed PUTs.
- **Dynamic replanning** — Steps added/removed mid-session.
- **Progress percentage / time estimates.**
- **Branching FSM visualization** — Showing conditional paths.
- **Full streaming text preview** — Monospace output, reasoning subsection in
  auto-expanded running blocks (deferred to v2).
- **Summary on session list page** — Data available, rendering deferred.
- **Custom summary prompts per workspace/job.**
- **Summary regeneration or editing.**

## Test Coverage

**`packages/core/src/session/`** — Unit tests for Zod schemas (parse/reject),
reducer (normal flow, failures, ephemeral routing by stepNumber, pending block
seeding, pending→running matching by name, pending→skipped on completion,
backward compat without plannedSteps, duplicate agent names), event emission
mapper (FSM event → session event mapping, agent-only filtering), storage
adapters (save/get round-trip, JSONL append/read-back, list filtering,
pre-computed summaries), planned steps graph traversal (linear FSM, branching,
multi-signal states, cycle detection, final state termination).

**`apps/atlasd/`** — Integration tests for SSE endpoint (event ordering, full
replay, recently-finalized replay), JSON endpoint (SessionView shape, active
snapshots, 410 for old format), list endpoint (pre-computed summaries, active
session live summaries), SessionEventStream (replay, finalization, ephemeral
non-persistence), SessionStreamRegistry (create/get/listActive/TTL eviction).
AI summary integration tests on detail and list endpoints.

**`src/core/`** — Unit tests for `generateSessionSummary()` (context assembly,
timeout fallback, API error fallback).

**`apps/web-client/`** — SSE consumer tests (parse, retry, named events).
