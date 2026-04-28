---
name: writing-workspace-jobs
description: "Authors FSM-based workspace jobs with correct trigger wiring, MCP tool naming, and state-machine structure. Use when creating or editing jobs, signals, or FSM workflows in workspace.yml; when an agent needs to convert an execution block to fsm; or when validating a job fails with structural errors."
---

# Writing workspace jobs

Guidance for authoring Friday workspace jobs that validate cleanly and run
reliably. Load this skill before authoring or editing any `fsm:` job.

## Checklist

- [ ] Job uses `fsm:` — not `execution:` (runtime silently skips non-FSM jobs)
- [ ] `initial` state exists in `states` and handles the trigger signal name in `on:`
- [ ] Every non-final state has at least one outgoing transition
- [ ] At least one state has `type: final`
- [ ] All `agentId` values exist in `agents`
- [ ] MCP tools use `serverId/toolName` format (not bare names)
- [ ] `emit` event names match `on` transition keys exactly
- [ ] Multi-step jobs chain via `outputTo` → `inputFrom`

## The trigger contract (common silent failure)

When a signal fires, the runtime does this:

1. Finds jobs whose `triggers` include the signal name.
2. Resets the FSM to `initial`.
3. Sends `{ type: <signal-name>, data: <payload> }` to the FSM engine.
4. Engine looks at `currentState.on[<signal-name>]`.
5. **If no handler matches, the signal is silently ignored.**

**Rule: The `initial` state's `on` key must exactly match the trigger signal name.**

Wrong — `triage-now` is ignored because `triage` has no handler for it:

```yaml
fsm:
  initial: triage
  states:
    triage:
      entry:
        - type: agent
          agentId: triage-agent
      on:
        done: { target: done }   # handles "done", NOT "triage-now"
    done:
      type: final
```

Right — `idle` handles the trigger and routes to the work state:

```yaml
fsm:
  initial: idle
  states:
    idle:
      on:
        triage-now: { target: run }
    run:
      entry:
        - type: agent
          agentId: triage-agent
      type: final
```

## MCP tool naming

`list_mcp_tools({ serverId: "google-gmail" })` returns bare names:

```json
[{ "name": "search_gmail_messages" }]
```

**Always use `serverId/toolName` in the agent's `tools` array.** The validator
accepts prefixed tools for declared servers even when the server isn't running.

| What `list_mcp_tools` returns | What you write in `agents.*.config.tools` |
|---|---|
| `"search_gmail_messages"` | `"google-gmail/search_gmail_messages"` |
| `"get_gmail_message_content"` | `"google-gmail/get_gmail_message_content"` |
| Built-in platform tool | `"memory_save"`, `"memory_read"` — no prefix |

## Minimal valid job

Copy this, change names, publish. Every field below is required.

```yaml
jobs:
  my-job:
    description: "One-line description of what this job does"
    triggers:
      - signal: my-signal
    fsm:
      initial: idle
      states:
        idle:
          on:
            my-signal: { target: run }
        run:
          entry:
            - type: agent
              agentId: my-agent
          type: final
```

Required pieces:
- `jobs.<job-id>` — kebab-case, referenced by signal `triggers`
- `triggers` — at least one `{ signal: <signal-name> }`
- `fsm.initial` — must be a key in `fsm.states`
- `fsm.states` — every non-final state must have `on` with outgoing transitions
- `type: final` on terminal states

## Multi-step pipeline

Chain agents with `outputTo` → `inputFrom` wiring. Each step emits `DONE`,
transitions to the next.

```yaml
fsm:
  initial: idle
  states:
    idle:
      on:
        go: { target: step-a }
    step-a:
      entry:
        - type: agent
          agentId: agent-a
          outputTo: step-a-result
        - type: emit
          event: DONE
      on:
        DONE: { target: step-b }
    step-b:
      entry:
        - type: agent
          agentId: agent-b
          inputFrom: step-a-result
        - type: emit
          event: DONE
      on:
        DONE: { target: completed }
    completed:
      type: final
```

Key fields:
- `outputTo: <doc-id>` — saves the agent's result as a named document
- `inputFrom: <doc-id>` — feeds a prior step's output into the next agent's task
- `emit` with `event: DONE` — signals the engine to transition

## Conditional branching

Use a transition array with guard functions. Guards are checked in order;
first passing guard wins. Always include a fallback.

```yaml
fsm:
  initial: idle
  states:
    idle:
      on:
        go: { target: decide }
    decide:
      entry:
        - type: agent
          agentId: router-agent
          outputTo: decision
        - type: emit
          event: DONE
      on:
        DONE:
          - target: path-a
            guards: [isPathA]
          - target: path-b
            guards: [isPathB]
          - target: path-default   # fallback, no guard
    path-a:
      entry:
        - type: agent
          agentId: agent-a
      type: final
    path-b:
      entry:
        - type: agent
          agentId: agent-b
      type: final
    path-default:
      type: final
  functions:
    isPathA:
      type: guard
      code: |
        export default function isPathA(context, event) {
          return context.results['decision']?.route === "a";
        }
    isPathB:
      type: guard
      code: |
        export default function isPathB(context, event) {
          return context.results['decision']?.route === "b";
        }
```

## Validation error decoder

The workspace config validator returns `errors` (blocks publish) and `warnings`
(advisory).

### Errors

| Code | Path | Fix |
|---|---|---|
| `unknown_tool` | `agents.X.config.tools[N]` | Add `serverId/` prefix for MCP tools; check spelling for built-in tools |
| `unknown_agent_id` | `jobs.Y.fsm.states.Z.entry[N].agentId` | Declare the agent in `agents` before the job; check spelling |
| `unknown_memory_store` | `agents.X` | Add the memory to `memory.own` or `memory.mounts` |
| `fsm_structural_error` | `jobs.Y.fsm.<path>` | Check `initial` exists, all `on` targets exist, no `type: action` (use `entry` array) |
| `invalid_type` | (varies) | Read the `message` field for expected vs received type |

### Warnings

| Code | When to ignore | When to fix |
|---|---|---|
| `orphan_agent` | Agent IS referenced inside a valid FSM `entry` — validator skips malformed FSMs during cross-check. Fix FSM first. | Agent genuinely unused — wrap it in a job or delete it. |
| `dead_signal` | Signal is reserved for future use or external callers. | Signal is genuinely orphaned — add a job trigger or delete it. |
| `missing_tools_array` | Agent has `tool_choice: none` or needs no tools. | Agent should call tools — add the `tools` array. |
| `cron_parse_failed` | Never ignore. | Fix the expression; use `crontab.guru` to validate. |
| `http_path_collision` | Never ignore. | Change one signal's `config.path` to a unique route. |

## Runtime anti-patterns

These pass validation but fail or misbehave at runtime.

### `execution:` instead of `fsm:`

The config schema accepts `execution:` for backward compatibility, but the
runtime **only executes FSM jobs**. Non-FSM jobs are silently skipped.

Symptom: `"No FSM job handles signal '<name>'"`  
Fix: Rewrite as `fsm:` with `initial` and `states`.

### Initial state with no signal handler

The `initial` state must handle the trigger signal name in its `on` map.
Without it, the signal is silently ignored.

Symptom: Job triggers but produces no output, no error, no session.  
Fix: Add `on: { <signal-name>: { target: <work-state> } }` to the initial state.

### Non-final state with no outgoing transitions

The FSM engine catches this in `validateFSMStructure`, but the workspace
config validator does not validate FSM internals (fsm is `z.any()` in
`JobSpecificationSchema`).

Symptom: FSM reaches a stuck state and the session hangs.  
Fix: Add transitions to every non-final state, or mark it `type: final`.

### `type: action` in states

The FSM engine supports `agent`, `llm`, and `emit` action types. `type: action`
is a legacy pre-FSM shape.

Symptom: `fsm_structural_error` at the MCP-registry validator (the second
validation layer).  
Fix: Use `entry: [ { type: agent, agentId: ... } ]`.

### Emit / transition name mismatch

An `emit` action sends an event to the FSM engine. The transition must match
the emitted event name exactly.

```yaml
entry:
  - type: emit
    event: DONE
on:
  DONE: { target: completed }   # matches
```

If you emit `COMPLETE` but transition on `DONE`, the event is queued but
never consumed.

Symptom: Agent runs but session never completes.  
Fix: Match emit event name to `on` key exactly.

### Missing `outputTo` in pipelines

Without `outputTo`, an agent's result is not saved as a document. The next
step's `inputFrom` has nothing to read.

Symptom: Second agent receives empty or undefined input.  
Fix: Add `outputTo: <doc-id>` to the producer and `inputFrom: <same-doc-id>`
to the consumer.

## Order of declaration

When building a workspace from scratch, declare in this order:

1. **Agents first** — jobs reference `agentId` in FSM `entry` actions.
2. **Jobs second** — they wire agents into the orchestration layer.
3. **Signals last** — external entry points; nothing else depends on them.

The validator catches `unknown_agent_id` when a job references an agent that
doesn't exist yet.

## Stuck-recovery heuristic

If validation fails 3+ times on the same operation:

1. Build a **minimum viable config** (just `version: "1.0"` + `workspace.name`)
   and confirm it validates cleanly.
2. Add **one section at a time** in this order: signals → agents → jobs.
3. Call `validate_workspace` after each addition.
4. The **first section that breaks** is the one to debug. Fix it before adding
the next.

This removes panic-driven shotgun debugging that produces orphaned agents,
malformed FSMs, and circular retries.

## Assets

- `assets/minimal-job-template.yml` — drop-in single-agent job. Copy, rename,
  publish.
- `assets/multi-step-job-template.yml` — chained agent pipeline with
  `outputTo` → `inputFrom` wiring.

## Companion skills

- `writing-workspace-signals` — Signal authoring: JSON Schema payloads, provider configs,
  HTTP path collisions, cron validation. Load before creating or editing any
  signal that accepts parameters or needs a webhook endpoint.
- `workspace-api` — Workspace building workflow: draft mode, CRUD, validation,
  reachability model, tool selection.
