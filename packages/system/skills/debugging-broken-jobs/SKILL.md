---
name: debugging-broken-jobs
description: |
  Triage entry-point for any "the job ran but something's wrong" situation in
  a Friday workspace. Loads when a job tool returns `output-error`,
  `success: false`, `summary: ""`, `artifactIds: []`, or any session with
  `status: failed`. Routes to the right sibling debug skill. Required reading
  before declaring "platform bug" / "FSM wiring is broken" / "this is a
  known issue" — those claims are FORBIDDEN without first walking this
  triage table.
---

# Debugging broken jobs

Stop. Before you form a hypothesis, walk this triage. The job tool's
return shape and the session's `agentBlocks[].toolCalls` carry the
diagnosis 95% of the time. The remaining 5% is rarely a platform bug
and almost always a contract violation by the agent or the FSM.

## Diagnostic discipline (non-negotiable)

You may NOT claim "platform bug" / "FSM wiring is broken" / "this is a
known issue" until you have:

1. Called `describe_session(sessionId)` on the failing session.
2. Read `agentBlocks[].toolCalls` to see what tools the agent
   actually invoked.
3. Verified the contracted exit (`complete` for `outputTo` actions,
   terminal text otherwise) was attempted.

If you skipped any of those, you don't know enough to claim a bug.
Run the steps first.

## Symptom triage table

Match the job tool's return shape OR the session's status, then load
the matching sibling skill.

| Symptom signature | Load |
|---|---|
| `success: true, status: completed, summary: ""`, `artifactIds: []` | `debugging-empty-output` |
| `success: true, status: completed`, summary mentions "Session completed without producing a summarizable document" | `debugging-empty-output` |
| Session shows many tool calls of the same name, no terminal text, hit `stopWhen: stepCountIs(...)` | `debugging-tool-loops` |
| Session `status: failed`, error contains `LLM action with outputTo '...' did not call complete` | `debugging-runtime-errors` |
| Session `status: failed`, error contains `emitted empty output` or `emitted an empty response` | `debugging-runtime-errors` |
| Session `status: failed`, error contains `LLM step failed: ...` (agent called `failStep`) | `debugging-runtime-errors` |
| Session `status: failed`, error contains `Agent '<id>' output does not match <type> schema` | `debugging-runtime-errors` |
| Session `status: failed`, error contains `Invalid job config` or `Invalid signal config` (Zod rejection) | `debugging-runtime-errors` |
| Job tool returned `output-error` with no meaningful error text (typically called with bare `{}`) | `debugging-job-invocation` |
| Job tool returned `output-error` mentioning "tool isn't bound" — this is wrong; you forgot a `prompt` arg | `debugging-job-invocation` |
| External MCP tool returned 422 / 401 / 403 with provider-side error | check the workspace's MCP server credentials; not a platform bug |

If no row matches, gather more evidence — don't escalate.

## What "diagnostic discipline" looks like in practice

```text
USER: run stale
ASSISTANT [calls workspace job tool]
JOB TOOL: { success: true, status: completed, summary: "", artifactIds: [] }
ASSISTANT [recognizes empty-output signature]
ASSISTANT [load_skill: debugging-empty-output]
ASSISTANT [calls describe_session(sessionId)]
ASSISTANT [reads agentBlocks[0].toolCalls]
ASSISTANT [observes complete was not called; agent emitted text only]
ASSISTANT: The job ran successfully but the agent emitted prose without
calling `complete`. Per the [[contracts/agent-action-handshake]]
contract, an `outputTo` action requires the agent to call complete
with the final text. Fix the agent's prompt to instruct it explicitly.
```

What you must NOT do:

```text
USER: run stale
ASSISTANT [calls job tool]
JOB TOOL: { summary: "" }
ASSISTANT: This looks like a platform bug. Let me try migrating from
Pattern A to Pattern B FSM…
```

That's a contract violation by you. Load this skill, walk the table,
diagnose properly.

## Cross-references

- [[contracts/agent-action-handshake]] — the FSM action ↔ agent
  prompt contract that most empty-output failures violate.
- [[author/writing-workspace-jobs]] — FSM authoring once you know
  what to fix.
- [[author/workspace-api]] — agent CRUD once you know the agent
  prompt is the broken part.
