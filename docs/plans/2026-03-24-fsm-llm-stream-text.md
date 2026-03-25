# Switch FSM LLM Provider from `generateText` to `streamText`

## Context

When `do_task` runs LLM-type actions via the FSM engine, `AtlasLLMProviderAdapter.call()` uses `generateText` which blocks until the entire multi-step tool-calling sequence completes. Users see nothing during LLM execution — tool calls only appear in batch after completion. Switching to `streamText` lets tool call events flow in real-time, matching how agent-type actions already work.

The infrastructure is mostly in place: `SignalWithContext` already defines `onStreamEvent`, `engine.signal()` already accepts it, and the ephemeral executor already has `buildStreamEventHandler` for converting stream chunks to `InnerToolCallEvent`. The gap is that LLM actions never emit to `onStreamEvent`.

## Changes

### 1. `packages/fsm-engine/types.ts` — Add callback to LLMProvider interface

Add optional `onStreamEvent` to the `call()` params:

```typescript
export interface LLMProvider {
  call(params: {
    // ...existing params...
    onStreamEvent?: (chunk: AtlasUIMessageChunk) => void;
  }): Promise<AgentResult<string, FSMLLMOutput>>;
}
```

Return type stays the same — callers still get the final result.

### 2. `packages/fsm-engine/llm-provider-adapter.ts` — Switch to `streamText`

Follow the exact pattern from `packages/core/src/agent-conversion/from-llm.ts:68-117`:

- Replace `generateText` import with `streamText`
- Accept `onStreamEvent` in call params
- Call `streamText(...)` (returns immediately)
- In `onChunk` callback, map AI SDK chunk types to `AtlasUIMessageChunk` and forward via `onStreamEvent`:
  - `tool-call` chunk → emit `tool-input-available`
  - `tool-result` chunk → emit `tool-output-available`
  - (text-delta is available for future use but not critical for MVP)
- Await result properties: `const [text, steps, toolCalls, toolResults] = await Promise.all([result.text, result.steps, result.toolCalls, result.toolResults])`
- Feed `{ steps, toolCalls, toolResults }` to `collectToolUsageFromSteps` (already compatible)
- Build and return the same `AgentResult` shape

### 3. `packages/fsm-engine/fsm-engine.ts` — Wire through and deduplicate

Two changes at ~line 1130 (and the retry at ~line 1197):

**a) Pass `onStreamEvent` to the LLM provider:**
```typescript
let result = await this.options.llmProvider.call({
  // ...existing params...
  onStreamEvent: sig._context?.onStreamEvent,
});
```

**b) Skip batch `emitToolEvents()` when streaming is active (lines 1146, 1213):**
```typescript
if (!sig._context?.onStreamEvent) {
  this.emitToolEvents(result, action, sig, currentState);
}
```

This prevents duplicates: when streaming, tool events already went out in real-time via `onStreamEvent`. When not streaming (workspace-runtime `onEvent`-only path, tests), batch emission continues unchanged.

### 4. `packages/system/agents/conversation/tools/do-task/ephemeral-executor.ts` — Wire `onStreamEvent` to `engine.signal()`

Extract the tool-chunk-to-inner-tool-call logic from `buildStreamEventHandler` into a reusable function (it currently requires a `SignalWithContext` param it doesn't really need for this path). Then pass `onStreamEvent` to the signal call:

```typescript
// Build handler that converts stream chunks → InnerToolCallEvent
const onStreamEvent = context.onInnerToolCall
  ? buildToolChunkHandler(context.onInnerToolCall)
  : undefined;

await engine.signal(
  { type: triggerSignalType },
  { sessionId: context.sessionId, workspaceId: context.workspaceId, onEvent, onStreamEvent },
);
```

The `onEvent` handler's `data-fsm-tool-call`/`data-fsm-tool-result` → `InnerToolCallEvent` conversion at lines 337-366 should be gated on `!onStreamEvent` to avoid duplicates, since those FSM events won't fire when streaming is active (per change #3).

### 5. `packages/fsm-engine/tests/llm-provider-adapter.test.ts` — Update mock model

The mock currently implements `doGenerate` and throws from `doStream`. Switch to implementing `doStream` that returns a proper async iterable with text + finish chunks. Keep existing assertions (same result shape). Add test case verifying `onStreamEvent` receives tool chunks.

## Key files

| File | Change |
|------|--------|
| `packages/fsm-engine/types.ts` | Add `onStreamEvent` to `LLMProvider.call()` params |
| `packages/fsm-engine/llm-provider-adapter.ts` | `generateText` → `streamText`, chunk forwarding |
| `packages/fsm-engine/fsm-engine.ts` | Pass through `onStreamEvent`, conditional `emitToolEvents` |
| `packages/system/agents/conversation/tools/do-task/ephemeral-executor.ts` | Wire `onStreamEvent` to `engine.signal()` |
| `packages/fsm-engine/tests/llm-provider-adapter.test.ts` | Update mock to `doStream`, add streaming tests |

## Reference: existing `streamText` pattern

`packages/core/src/agent-conversion/from-llm.ts:68-117` — already does exactly this migration in a different context. Use as the template for the adapter change.

## Test impact

**Must update (mocks AI SDK model directly):**
- `packages/fsm-engine/tests/llm-provider-adapter.test.ts` — switch mock from `doGenerate` to `doStream`, add `onStreamEvent` test

**Safe — mock `LLMProvider` at interface level (optional param, won't break):**
- `packages/fsm-engine/tests/fsm.test.ts` — full FSM integration
- `packages/fsm-engine/tests/complete-tool-injection.test.ts` — complete/failStep extraction
- `packages/fsm-engine/tests/llm-validation.test.ts` / `llm-validation-integration.test.ts` — retry path
- `packages/fsm-engine/tests/llm-prompt-input.test.ts` — prompt building
- `packages/fsm-engine/tests/image-context.test.ts` — image parts
- `packages/fsm-engine/tests/results-accumulator.test.ts` / `unstringify-results.test.ts` — result storage

**Do-task tests (may need update for `onStreamEvent` wiring):**
- `packages/system/agents/conversation/tools/do-task/ephemeral-executor.test.ts`
- `packages/system/agents/conversation/tools/do-task/fastpath-wiring.test.ts`

## Verification

1. `deno task test packages/fsm-engine/tests/llm-provider-adapter.test.ts` — adapter returns same result shape, `onStreamEvent` receives chunks
2. `deno task test packages/fsm-engine/tests/` — all FSM engine tests still pass
3. `deno task test packages/system/agents/conversation/tools/do-task/` — do-task tests still pass
4. `deno task typecheck` — no type errors from interface change
5. Manual: run daemon, send a task that hits an LLM action, verify tool calls appear in real-time in the chat UI (not batched after completion)
