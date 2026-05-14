---
name: debugging-runtime-errors
description: |
  Loads when a session ends with `status: failed` AND a structured error
  message. Recognize: `did not call complete` (agent never called the
  injected complete tool); `emitted empty output` (called complete with
  `{}`); `emitted an empty response` (called complete with empty string);
  `LLM step failed:` (agent called failStep); `output does not match
  schema` (outputType validation failed); `Invalid job config` /
  `Invalid signal config` (Zod schema rejection on upsert). Each pattern
  has a one-line fix in the table below.
---

# Debugging runtime errors

When a session emits `status: failed` with a specific error message,
the message itself names the contract violation. This skill maps each
error pattern to its fix.

## Error → fix table

### `LLM action with outputTo '<doc>' did not call complete`

The action set `outputTo` so the runtime injected a `complete` tool.
The LLM finished without calling it.

**Fix:** update the agent's prompt to explicitly call `complete`:

```
"When you have the final result, call the `complete` tool with
`{response: '<your final text>'}`. The runtime captures your output
from this call."
```

See `@friday/agent-action-handshake` for the full contract.

### `LLM action with outputTo '<doc>' emitted empty output`

The LLM called `complete({})`. Same fix — the prompt needs to specify
what the args should contain.

### `LLM action with outputTo '<doc>' emitted an empty response`

The LLM called `complete({response: ""})`. Same fix — the prompt
needs to populate `response` with actual content.

### `LLM step failed: <reason>`

The agent called `failStep` deliberately. Read the reason; it's
usually accurate. Either:
- The task was impossible given the agent's tools/inputs → adjust
  the inputs or the agent's tool surface.
- The agent gave up too easily → tighten the prompt to handle the
  edge case.

### `Agent '<agentId>' output does not match <type> schema: ...`

The action declared `outputType: <type>` and the agent's output
doesn't match the JSON Schema in `documentTypes.<type>`. The error
message names the specific path that failed validation.

**Fix:**
- If the schema is wrong → update `documentTypes.<type>`.
- If the agent's output is wrong → update the agent's prompt to
  produce data matching the schema, or add an example in the prompt.

### `Invalid job config: ...` (on `upsert_job`)

Zod rejected the job config on upsert. Common causes:
- `execution.agents[]` contained inline objects when only string IDs
  are accepted in Pattern A.
- `fsm.states.<state>.entry[]` action `type` was not one of `llm`,
  `agent`, `emit`, `notification`.
- `outputTo` placed on an inline `type: llm` action without the
  outer FSM wrapper.

**Fix:** load `@friday/writing-workspace-jobs` for the canonical
Pattern A vs Pattern B shapes. The error message names the exact
path that failed.

### `Invalid signal config: ...` (on `upsert_signal`)

Zod rejected the signal config. Common cause: missed the inner
`config: {path: ...}` and put `path` directly on the outer config.

**Fix:** the shape is

```
{
  id: "<signalId>",
  config: {
    provider: "http",
    description: "...",
    config: { path: "/your-path" }
  }
}
```

See `@friday/writing-workspace-signals` for templates.

### `Signal payload validation failed for '<signalId>': ...`

The signal declared a JSON Schema and the trigger payload doesn't
match.

**Fix:** match the schema, OR loosen the schema if the new payload
shape is correct.

## What NOT to do

- **Do NOT wrap the failing job in a try/catch and silently retry.**
  These errors are contract violations; retrying without fixing them
  produces the same error.
- **Do NOT migrate Pattern A → Pattern B "to fix" a `did not call
  complete` error.** That error means the agent prompt is wrong, not
  the FSM shape.

## Cross-references

- `@friday/debugging-broken-jobs` — the triage entry point.
- `@friday/agent-action-handshake` — the cross-boundary
  contract most of these errors violate.
- `@friday/writing-workspace-jobs` — FSM authoring.
- `@friday/writing-workspace-signals` — signal config templates.
