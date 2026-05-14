---
name: debugging-job-invocation
description: |
  Loads when a workspace job tool (called from chat) returns `output-error`
  with no meaningful error text — typically because the tool was invoked
  with bare `{}`. Job tools require `{prompt: "..."}` — the prompt becomes
  the signal payload. Do NOT conclude "the tool isn't bound to this chat
  session"; retry with a prompt arg first. Also covers Pattern A vs Pattern
  B job shapes and the manual / signal-name distinction.
---

# Debugging job invocation

Symptom: a workspace job tool was called from chat and returned
`state=output-error` with little or no error text. The chat agent's
instinct is to declare "the tool isn't bound to this chat session"
and abandon the job. That instinct is wrong.

## Quick fix: pass a `prompt` arg

Job tools accept `{prompt: "..."}` — the prompt becomes the signal
payload. Calling with bare `{}` errors out before the FSM even
fires.

Wrong:
```
job_tool_name({})  → output-error
```

Right:
```
job_tool_name({prompt: "Run the report."})  → success / structured failure
```

Always include `prompt`. If the job's signal has a more specific
schema (e.g. `{message_id: string, tone: string}`), pass that
instead — but `prompt` is the universal fallback.

## Pattern A vs Pattern B distinction

Workspaces have two job shapes:

- **Pattern A** (`execution.strategy: sequential`): a list of
  agents that run in order. The final agent's assistant text
  becomes the session's natural output. Captured by the
  chat-tool wrapper without explicit `outputTo`.
- **Pattern B** (`fsm:`): a state machine with named states,
  entry actions, and explicit `outputTo` documents. Output flows
  through the FSM document store; needs `outputTo` for the
  caller to see anything.

The chat trajectory that motivated this skill migrated a Pattern A
job to Pattern B "to get `outputTo`" — that was the wrong fix. The
original Pattern A would have worked with a small prompt change.

**Rule of thumb:** if the existing job is Pattern A and producing
empty output, the fix is in the agent's prompt, not in the FSM
shape. Migrating Pattern A → Pattern B introduces the
`complete`-injection contract that is itself a common failure
source — see `@friday/debugging-empty-output`.

## `manual` is a string, not a magic value

Some Pattern A jobs use `triggers: [{signal: "manual"}]`. This
means "this job is invoked directly via the chat-side tool wrapper,
not via an HTTP signal." It is NOT the FSM event name and there's
no signal called `manual` registered.

If you migrate this job to Pattern B FSM and try to use `manual`
as the FSM event name in `idle.on.manual`, that's syntactically
valid but semantically nonsensical — there's no signal firing
`manual` events.

For Pattern B, register a real HTTP signal (e.g. `stale-signal`
with `path: /stale`) and reference it in both `triggers` and
`fsm.idle.on.<signal>`.

## When the job tool genuinely isn't bound

Distinct from the bare-`{}` case above: here the tool name does not
exist in your tool set at all — calling it returns
`Model tried to call unavailable tool '<name>'`.

The usual cause: **you created the job this session.** Job tools are
bound from a config snapshot taken when the chat session started, so a
job you just made via `upsert_job` has no dedicated tool until the next
session. This is expected, not a bug — and you do NOT need to tell the
user to send another message.

**Fix: run it with `trigger_signal`.** Call
`trigger_signal({ signalId, payload })` with the job's trigger signal
id. That fires the job through the signal endpoint and blocks until it
completes — the in-session equivalent of the bound tool.

Other real causes (rare):
- Jobs whose `triggers` list is empty — no signal, nothing to fire.
- Jobs whose signal is unknown to the runtime.

Diagnose by calling `list_jobs(workspaceId)`. If the job appears with a
trigger signal, invoke it via `trigger_signal` with that signal id. If
it has no trigger, fix the workspace config.

## Cross-references

- `@friday/debugging-broken-jobs` — the triage entry point.
- `@friday/debugging-empty-output` — Pattern A → B migration is rarely
  the right fix for empty output.
- `@friday/writing-workspace-jobs` — Pattern A vs B authoring.
- `@friday/writing-workspace-signals` — signal authoring.
