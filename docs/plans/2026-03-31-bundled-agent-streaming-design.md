<!-- 2026-03-31 - Bundled Agent Streaming Migration -->

## Problem Statement

When the conversation agent invokes bundled agents via `do_task`, the user sees
a single "Searches the web for..." progress message and then nothing for up to
90 seconds while the agent runs internally. All tool calls made by bundled
agents (web searches, page fetches, SQL queries, Slack posts, calendar lookups)
are invisible because the agents use `generateText`, which blocks until
completion and emits no stream events.

The platform already has infrastructure for surfacing inner tool calls
(`data-inner-tool-call` events, `StreamEmitter` on `AgentContext`,
`buildToolChunkHandler` in the ephemeral executor). MCP-routed tool calls
already appear in real time. The gap is that bundled agents' own LLM tool loops
are opaque.

## Solution

Migrate all 14 `generateText` call sites reachable from the conversation agent
to `streamText`, using a shared wrapper that:

1. Calls `streamText` with the same parameters the agent was already passing
2. Iterates `fullStream` and emits tool-call/tool-result chunks via the
   agent's `StreamEmitter` in real time
3. Returns a resolved object matching `generateText`'s synchronous property
   access pattern, so consuming code requires zero changes

The existing event forwarding chain handles the rest:
`StreamEmitter` -> SSE -> orchestrator -> `buildToolChunkHandler` ->
`emitInnerToolCall` -> `UIMessageStreamWriter` -> conversation UI.

## User Stories

1. As a user waiting for a web search, I want to see each search query and page
   fetch as it happens, so I know the agent isn't stuck
2. As a user watching a data analysis, I want to see SQL queries executing in
   real time, so I can follow the agent's reasoning
3. As a user sending a Slack message, I want to see the Slack API calls as they
   happen, so I have confidence the message was sent
4. As a user watching any bundled agent, I want to see tool calls appear in the
   conversation's collapsible group, so I understand what work is being done
5. As a developer adding a new bundled agent, I want streaming to be automatic
   when I use the shared wrapper, so I don't need to wire up event forwarding
   manually

## Implementation Decisions

### Shared wrapper: `streamTextWithEvents`

A single async function that replaces `generateText` in bundled agents. Lives
in `packages/agent-sdk/src/vercel-helpers/` alongside existing stream utilities
(`stream-mapper.ts`, `json-repair.ts`).

**Interface:**

```typescript
import { streamText } from "ai";

type StreamTextParams = Parameters<typeof streamText>[0];

interface StreamTextWithEventsOptions {
  /** streamText parameters (model, tools, messages, etc.) */
  params: StreamTextParams;
  /** StreamEmitter from AgentContext for forwarding tool events */
  stream?: StreamEmitter;
}

/**
 * Wrapper around streamText that forwards tool events via StreamEmitter
 * and returns a resolved object matching generateText's sync access pattern.
 */
async function streamTextWithEvents(
  opts: StreamTextWithEventsOptions
): Promise<ResolvedStreamResult>
```

**Return type** mirrors `generateText`'s result so consuming code doesn't
change:

```typescript
interface ResolvedStreamResult {
  text: string;
  finishReason: FinishReason;
  usage: LanguageModelUsage;
  totalUsage: LanguageModelUsage;
  steps: StepResult[];
  toolCalls: ToolCall[];
  toolResults: ToolResult[];
}
```

**Implementation approach:**

```typescript
async function streamTextWithEvents({ params, stream }: StreamTextWithEventsOptions) {
  const result = streamText(params);

  for await (const chunk of result.fullStream) {
    if (!stream) continue;

    if (chunk.type === "tool-call") {
      stream.emit({
        type: "tool-input-available",
        toolCallId: chunk.toolCallId,
        toolName: chunk.toolName,
        input: chunk.input,
      });
    } else if (chunk.type === "tool-result") {
      stream.emit({
        type: "tool-output-available",
        toolCallId: chunk.toolCallId,
        output: chunk.output,
      });
    }
  }

  return {
    text: await result.text,
    finishReason: await result.finishReason,
    usage: await result.usage,
    totalUsage: await result.totalUsage,
    steps: await result.steps,
    toolCalls: await result.toolCalls,
    toolResults: await result.toolResults,
  };
}
```

This matches the chunk type conversion already used in
`packages/fsm-engine/llm-provider-adapter.ts` (lines 69-96), keeping the event
format consistent across the platform.

### Why a wrapper, not per-agent streaming

All 14 call sites consume `generateText` results identically: await the call,
access properties synchronously (`result.text`, `result.finishReason`,
`result.steps`, etc.). A shared wrapper means:

- Zero changes to consuming code in each agent
- Single place to evolve the forwarding logic
- Consistent event format across all bundled agents
- New agents get streaming for free

### Migration scope: 14 call sites across 11 files

**Bundled agents (via `do_task`):**

| Agent | File | Calls | Model |
|---|---|---|---|
| Snowflake Analyst | `bundled-agents/src/snowflake-analyst/agent.ts` | 1 | sonnet |
| Data Analyst | `bundled-agents/src/data-analyst/agent.ts` | 1 | sonnet |
| Web Search | `bundled-agents/src/web-search/web-search.ts` | 1 | sonnet |
| Google Calendar | `bundled-agents/src/google/calendar.ts` | 1 | haiku |
| Summary | `bundled-agents/src/summary.ts` | 1 | haiku |
| HubSpot | `bundled-agents/src/hubspot/agent.ts` | 1 | haiku |
| Slack Communicator | `bundled-agents/src/slack/communicator.ts` | 2 | haiku |
| Email Communicator | `bundled-agents/src/email/communicator.ts` | 1 | haiku |
| CSV Filter | `bundled-agents/src/csv/filter.ts` | 2 | groq |

**System agent (direct tool in conversation agent):**

| Agent | File | Calls | Model |
|---|---|---|---|
| Workspace Planner | `system/agents/workspace-planner/workspace-planner.agent.ts` | 1 | haiku |

### Workspace planner is a special case

The workspace planner is registered as a direct system agent tool in
`conversation.agent.ts`, not invoked via `do_task`. It receives `AgentContext`
with `stream`, so the wrapper works the same way. However, its `generateText`
call is minimal (no tools, just text generation for summaries) so streaming adds
no user-visible value. Include it for consistency but it's low priority.

### What changes per agent

Each agent's migration is mechanical:

1. Replace `import { generateText } from "ai"` with
   `import { streamTextWithEvents } from "@atlas/agent-sdk/vercel-helpers"`
2. Change `await generateText({ model, tools, ... })` to
   `await streamTextWithEvents({ params: { model, tools, ... }, stream: context.stream })`
3. No other changes needed — result access patterns are identical

### Existing event forwarding chain (no changes needed)

The infrastructure from `StreamEmitter` to conversation UI is already wired:

1. **Bundled agent** emits chunk via `context.stream.emit()`
2. **MCP server** streams it via SSE to the orchestrator
3. **Orchestrator** receives chunk via SSE reader
4. **`buildStreamEventHandler`** in ephemeral executor forwards to
   `buildToolChunkHandler`
5. **`buildToolChunkHandler`** converts to `InnerToolCallEvent`
6. **`emitInnerToolCall`** writes `data-inner-tool-call` to
   `UIMessageStreamWriter`
7. **Frontend** renders tool call in the conversation's collapsible group

### Error handling

`streamText` suppresses errors by default — they surface when consuming the
stream. The wrapper iterates `fullStream` (which will throw on stream errors)
inside a try/catch. Errors during streaming should be caught and rethrown so
agents' existing error handling (checking `finishReason === "error"`, try/catch
blocks) continues to work.

The wrapper should also handle the case where `fullStream` iteration fails
partway through — the resolved properties may not be available. In that case,
rethrow the original error.

### No changes to event allowlists

`data-inner-tool-call` is already an allowed event type in the streaming signal
trigger's allowlist. The `tool-input-available` and `tool-output-available`
chunk types emitted by the wrapper are internal to the SSE stream between
the MCP server and orchestrator — they get converted to `InnerToolCallEvent`
before reaching the allowlist check.

## Testing Decisions

### What makes a good test

Tests should verify that tool events are emitted during streaming, not test
the AI SDK's streaming internals. Mock the LLM response, assert that the
`StreamEmitter` receives the expected tool-call/tool-result chunks.

### Modules to test

- **`streamTextWithEvents` wrapper** — Unit test: given a mocked `streamText`
  that produces tool-call and tool-result chunks, verify the `StreamEmitter`
  receives the correct events in order, and the returned object has the
  expected resolved values. Test with and without a `StreamEmitter` (graceful
  no-op when `stream` is undefined).

- **Integration test** — Verify end-to-end that a bundled agent's tool calls
  appear as `data-inner-tool-call` events in the conversation stream. Use an
  existing agent test pattern with a mocked LLM provider.

### Prior art

- `packages/fsm-engine/tests/llm-provider-adapter.test.ts` — tests the FSM
  engine's `streamText` + `onChunk` pattern
- Existing bundled agent tests mock `generateText` — these need updating to
  mock `streamText` via the wrapper

### Manual tool call emissions for non-LLM operations

The `streamTextWithEvents` wrapper only surfaces tool calls that happen inside
the LLM's tool loop. Agents that do significant work outside the LLM loop
(direct API calls, artifact creation, etc.) need manual emissions.

The web-search agent was the first case. After `analyzeQuery` (which is an LLM
tool call, automatically forwarded), it runs `executeSearch` (direct Parallel
API call) and `generateResponse` (a `generateObject` call for synthesis). These
were invisible until we added a helper:

```typescript
async function emitToolCall<T>(
  stream: StreamEmitter | undefined,
  toolName: string,
  input: unknown,
  fn: () => Promise<T>,
): Promise<T> {
  const toolCallId = randomUUID();
  stream?.emit({ type: "tool-input-available", toolCallId, toolName, input });
  const result = await fn();
  stream?.emit({ type: "tool-output-available", toolCallId, output: result });
  return result;
}
```

This wraps any async operation with paired start/complete events that flow
through the same `buildToolChunkHandler` chain. The frontend renders them
identically to LLM tool calls in `tool-call-group.svelte` with
Request/Response tabs.

**Applied to web-search agent:**
- `executeSearch` — Request: `{ queries, complexity }`, Response: search results
- `generateReport` — Request: `{ sourceCount }`, Response: synthesized report

This pattern should be applied to other agents that have similar non-LLM
operations (e.g., artifact creation, external API calls) where user visibility
is valuable.

### Conversation agent prompt change

Added "Always Acknowledge Before Acting" rule to the conversation agent's
system prompt (`packages/system/agents/conversation/prompt.txt`). The agent
was going directly to `do_task` without any text acknowledgment, leaving the
user staring at a blank screen until progress events appeared. Now it sends
a brief one-sentence acknowledgment before tool calls.

## Implementation Status

**Completed (PR #2797):**
- `streamTextWithEvents` wrapper created and exported
- 13 `generateText` calls migrated across 10 bundled agent files
- Manual `emitToolCall` emissions added to web-search agent
- Conversation agent prompt updated with acknowledgment rule
- Typecheck passing

**Not migrated (intentionally):**
- Workspace planner — no tools, just text generation for summaries. Zero tool
  events to forward.
- `generateText` calls not reachable from conversation agent (`small.ts`,
  `mappings.ts`, `enrich-pipeline-context.ts`, `direct-executor.ts`, evals)

**Follow-up work:**
- Apply `emitToolCall` pattern to other bundled agents with significant
  non-LLM operations (data-analyst SQL queries, calendar MCP calls, etc.)
- Add unit tests for `streamTextWithEvents` wrapper
- Update existing bundled agent tests that mock `generateText` to mock
  `streamText` via the wrapper

## Out of Scope

- Frontend rendering changes (already handled by existing `data-inner-tool-call`
  rendering)
- Streaming text deltas from bundled agents (only tool events are forwarded)
- Changes to the event forwarding chain (`buildToolChunkHandler`,
  `emitInnerToolCall`, etc.)
- Deprecating `generateText` imports across the codebase

## Further Notes

The `packages/fsm-engine/llm-provider-adapter.ts` already implements this exact
pattern for LLM actions — `streamText` with `onChunk` converting to
`tool-input-available`/`tool-output-available` events. The wrapper reuses the
same event format for consistency.

The wrapper uses `fullStream` iteration rather than `onChunk` callback because
`fullStream` is an `AsyncIterable` that naturally integrates with the wrapper's
async flow — iterate to forward events, then resolve properties after the stream
completes. `onChunk` would require coordinating a separate callback with the
property resolution.

Agents that pass `context.stream` as `undefined` (e.g., when invoked outside
the conversation agent context) get identical behavior to today's `generateText`
— the wrapper skips event emission and just resolves the properties.
