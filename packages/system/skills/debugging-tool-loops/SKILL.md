---
name: debugging-tool-loops
description: |
  Loads when a session shows many tool calls (often the same name repeated)
  with no terminal text, no `complete` call, and either hits
  `stopWhen: stepCountIs(...)` (default 10) OR exhausts max output tokens.
  The LLM is in a tool loop without producing a final message. Distinguish
  from `debugging-empty-output` — that's about contract exits being absent;
  this is about the LLM never deciding to stop. Required: the agent prompt
  needs an explicit termination criterion.
---

# Debugging tool loops

Symptom: agent makes 8+ tool calls (often repeating searches with
slight variations), eventually hits `stepCountIs(10)` cap or runs out
of output tokens, ends with `output: {response: ""}` or empty
`complete` args.

## Diagnostic checklist

### 1. Confirm the loop signature

```
describe_session(sessionId) → session.agentBlocks[].toolCalls
```

Look for:
- 6+ tool calls in a single agent block.
- Repeated calls to similar tools (`search_issues` × 3,
  `search_pull_requests` × 3, then more search variations).
- No `complete` or `failStep` toolName in the list.
- Final assistant text is empty.

If the agent IS calling `complete` but with empty args, that's
[[debugging-empty-output]] step 2, not this skill.

### 2. Check the agent prompt's termination criterion

A loop usually means the agent doesn't know when to stop searching.
Look for prompts like:

```
"Search for all stale issues across all repos."
```

The LLM keeps searching because "all" is open-ended. Add an explicit
stop condition:

```
"Search exactly these 6 queries (3 issue queries × 3 PR queries).
After all 6 return, stop and call `complete` with the report. Do not
search again."
```

### 3. Check whether the agent has the right *terminal* tool

If `outputTo` is set, the runtime auto-injects `complete` and stops
the LLM when complete is called (`stopWhen: hasToolCall("complete")`).
If `outputTo` is NOT set, the LLM stops only on `stepCountIs(...)` or
max output tokens. Without an `outputTo`, you're at the mercy of the
LLM's own sense of when to stop.

Consider adding `outputTo: response` to the FSM action to give the LLM
a clear exit hatch.

### 4. Bump `max_steps` only as a last resort

The default `max_steps: 10` is generous for most agents. If you
genuinely need more (e.g., a job that fans out to 20 repos), bump it
in the action's `config.max_steps`. But: if you're hitting 20 steps
and still not done, the prompt is wrong, not the budget.

## What NOT to do

- **Do NOT bump `max_output_tokens` to "fix" the loop.** Token budget
  isn't the issue — the agent isn't producing tokens, it's producing
  tool calls. More budget = more loops.
- **Do NOT swap to a more capable model.** Tool loops aren't a model
  capability problem; they're a prompt instruction problem.

## Cross-references

- [[debugging-broken-jobs]] — the triage entry point.
- [[debugging-empty-output]] — sibling for "complete present but
  empty" cases.
- [[contracts/agent-action-handshake]] — the `outputTo` + `complete`
  injection contract that gives a terminal exit.
