---
name: debugging-empty-output
description: |
  Loads when a workspace job tool returns `success: true, status: completed`
  AND (`summary: ""` OR `artifactIds: []` OR summary equals
  "Session completed without producing a summarizable document"). Diagnostic
  checklist for sessions that ran successfully but emitted nothing useful.
  Most common cause: the agent's prompt didn't instruct the LLM to call
  `complete()` for an `outputTo` action. Do NOT migrate Pattern A → Pattern
  B FSM as a fix — that's almost always wrong.
---

# Debugging empty-output sessions

Symptom: session `status: completed` but the chat-tool wrapper got back
nothing useful — empty `summary`, empty `artifactIds`, or the sentinel
"Session completed without producing a summarizable document."

## Diagnostic checklist

Walk in order. Each step has a concrete fix.

### 1. Read `aiSummary.summary` from `describe_session`

The daemon synthesizes a useful diagnosis post-completion. The SSE
`job-complete` may have fired before `aiSummary` was ready, so the
chat-tool wrapper's `summary` field can be empty even when
`describe_session` has the right answer.

```
describe_session(sessionId) → check session.aiSummary.summary
```

If `aiSummary.summary` reads "completed without producing a
summarizable document" → continue to step 2 (the agent didn't emit).

If `aiSummary.summary` describes what actually happened → surface
that to the user. The job worked but the wrapper dropped the summary.
Phase 2 of the system-skills remodel made `buildSessionJobResult`
never return empty; if you're still seeing empty, you're on stale code.

### 2. Inspect `agentBlocks[].toolCalls` for `complete`

```
describe_session(sessionId) → session.agentBlocks[<last>].toolCalls
```

For an action with `outputTo: response` (or any `outputTo`), the
runtime auto-injects a `complete` tool. The agent MUST call it.

- If `complete` IS in toolCalls → check `output: { response: "..." }`
  for empty content. The agent called complete with nothing. Fix the
  prompt so the LLM puts the actual final text in the `complete` arg.
- If `complete` is NOT in toolCalls → the agent never called the
  contracted exit. Fix: update the agent's prompt to explicitly
  instruct "When done, call the `complete` tool with `{response:
  '<the full final text>'}`. This is how the FSM captures your
  output."

See [[contracts/agent-action-handshake]] for the full contract.

### 3. Check the agent prompt's instructions

The most common pattern that causes silent emptiness:

```
"output ONLY the finished markdown report below as your final
message. Do not add any preamble..."
```

This prompt tells the LLM to stream prose. With `outputTo` set, the
runtime expects the prose to come via `complete(...)` — not as a final
assistant message. Replace with:

```
"When you have the report, call the `complete` tool with
`{response: '<the full markdown report>'}`. Do not stream the report
as text — the runtime captures it from `complete`."
```

### 4. Confirm via test invocation

After updating the prompt, fire the job again. The new session should
show `complete` in toolCalls and a populated `summary`/`artifactIds`.

If still empty → recurse to step 2 with the new session's data, OR
load [[debugging-tool-loops]] (the agent might be stuck calling
search/fetch tools instead of finishing).

## What NOT to do

- **Do NOT migrate the job from Pattern A (`execution.strategy:
  sequential`) to Pattern B (`fsm:`).** Pattern A returns the final
  agent's text via the session natively. Migrating to Pattern B
  introduces the very `complete`-injection contract that you're
  fighting.
- **Do NOT add `create_artifact` to the agent's `tools:` list as a
  workaround.** Platform tools (including `create_artifact`)
  auto-inject regardless of `tools:`. The agent already has it. The
  problem is the agent's prompt, not its tool surface.
- **Do NOT declare "platform bug" or "FSM wiring is broken."** If you
  reach for that, you skipped step 2.

## Cross-references

- [[contracts/agent-action-handshake]] — the `outputTo` + `complete`
  injection contract.
- [[debugging-broken-jobs]] — the triage entry point.
- [[debugging-tool-loops]] — sibling skill for agent-stuck-in-tools.
- [[author/writing-workspace-jobs]] — Pattern A vs B; what
  `outputTo` does.
