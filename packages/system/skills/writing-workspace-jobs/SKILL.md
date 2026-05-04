---
name: writing-workspace-jobs
description: "Author FSM workspace jobs. Use when creating, editing, or debugging jobs, signals, or FSM workflows in workspace.yml."
---

# Writing workspace jobs

Validate cleanly. Run reliably. Load before authoring any `fsm:` job.

## Checklist

- [ ] Job uses `fsm:` — `execution:` silently skipped by runtime
- [ ] `initial` state exists in `states`, handles trigger signal name in `on`
- [ ] Every non-final state has ≥1 outgoing transition
- [ ] ≥1 state has `type: final`
- [ ] All `agentId` values exist in `agents`
- [ ] MCP tools use `serverId/toolName` format
- [ ] `emit` event names match `on` transition keys exactly
- [ ] Multi-step jobs chain via `outputTo` → `inputFrom` (array form when step needs >1 prior output)

## Trigger contract (common silent failure)

Signal fires → runtime finds matching job → resets FSM to `initial` → sends `{ type: <signal>, data: <payload> }` → engine checks `currentState.on[<signal>]`.

**No handler match = silently ignored.**

Rule: `initial` state's `on` key must exactly match trigger signal name.

Wrong — `triage-now` ignored because `triage` handles only `done`:

```yaml
fsm:
  initial: triage
  states:
    triage:
      entry:
        - type: agent
          agentId: triage-agent
      on:
        done: { target: done }
    done:
      type: final
```

Right — `idle` handles trigger, routes to work state:

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

**Always use `serverId/toolName` in `agents.*.config.tools`.** Validator accepts prefixed tools for declared servers even when server offline.

| `list_mcp_tools` returns | Write in `agents.*.config.tools` |
|---|---|
| `"search_gmail_messages"` | `"google-gmail/search_gmail_messages"` |
| `"get_gmail_message_content"` | `"google-gmail/get_gmail_message_content"` |
| Built-in platform tool | `"memory_save"`, `"memory_read"` — no prefix |

## Minimal valid job

Copy, rename, publish. Every field required.

```yaml
jobs:
  my-job:
    description: "One-line description"
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
- `triggers` — at least one `{ signal: <name> }`
- `fsm.initial` — key in `fsm.states`
- `fsm.states` — every non-final state needs `on` with outgoing transitions
- `type: final` on terminal states

## Multi-step pipeline

Chain agents with `outputTo` → `inputFrom`. Each step emits `DONE`, transitions forward.

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
- `outputTo: <doc-id>` — saves agent result as named document
- `inputFrom: <doc-id>` — feeds prior step output into next agent task
- `emit` with `event: DONE` — signals engine to transition

## Returning data to the caller

`outputTo` does double duty. Inside a multi-step FSM it chains a step's output into the next step's `inputFrom` (above). It is **also the only mechanism for surfacing data back to whoever fired the signal** — the synchronous signal response (`POST /api/workspaces/:id/signals/:id`) returns docs collected from `engine.documents` as `output: [{ id, type, data }]`. No `outputTo` → no doc → caller sees `output: []` even on `status: completed`.

There is no separate `outputs:` block on a job that pipes the FSM result to the caller. The schema has an `outputs:` field but it's a memory-write declaration (`{ memory, entryKind }`) — unrelated.

**Single-step jobs that need to return data:** put `outputTo` on the entry action even when the state is `type: final`. Entry actions still execute on entering a final state, and the doc is captured before session completion.

```yaml
fsm:
  initial: idle
  states:
    idle:
      on: { run-search: { target: search } }
    search:
      entry:
        - type: agent
          agentId: search-agent
          outputTo: search-result          # required for output to reach caller
          prompt: "{{inputs.query}}"
      type: final                           # entry runs THEN state finalizes
```

Caller sees:

```json
{
  "status": "completed",
  "sessionId": "...",
  "output": [
    { "id": "search-result", "type": "AgentResult", "data": { ... } }
  ]
}
```

**Verify after publish.** Fire the signal once with a fixture payload (`POST /api/workspaces/:id/signals/:signalId` with a JSON body) and confirm `output` is non-empty before declaring the workspace done. `output: []` means the data never reached the caller — almost always a missing `outputTo`.

## Multi-input steps

Step needs multiple prior outputs? Pass `inputFrom` as array. Engine concatenates each doc labeled by id (`<id>:\n<data>`) with blank lines between. Agent receives combined text as task.

```yaml
fetch-emails:
  entry:
    - type: agent
      agentId: gmail-agent
      outputTo: emails-result
    - type: emit
      event: DONE
  on:
    DONE: { target: fetch-calendar }

fetch-calendar:
  entry:
    - type: agent
      agentId: gcal-agent
      outputTo: calendar-result
    - type: emit
      event: DONE
  on:
    DONE: { target: summarize }

summarize:
  entry:
    - type: agent
      agentId: summarizer-agent
      inputFrom: [emails-result, calendar-result]
      outputTo: brief-result
      prompt: |
        Produce daily brief from emails and calendar data below.
        Group by source. Keep scannable.
    - type: emit
      event: DONE
```

Agent receives:
```
emails-result: <emails data>

calendar-result: <calendar data>
```

Use array `inputFrom` for "combine N results".

## Signal payload threading

Signal-payload fields are auto-seeded into `prepareResult.config` and reachable as `{{inputs.<field>}}` in **every** step's `prompt` — not just the first. This holds even when a step also declares `inputFrom`: the engine merges chained-doc keys on top of the carried-over signal payload, so end-to-end values like a recipient email or a target id keep resolving through the whole pipeline.

Use this for values that the entire job needs and the caller supplies. Don't try to thread them through `inputFrom` chains by re-emitting them in each agent's output — agents drop fields, paraphrase JSON, or just forget. The signal payload is the only durable carrier.

```yaml
signals:
  send-report:
    schema:
      type: object
      properties:
        report_id:    { type: string }
        notify_email: { type: string }
      required: [report_id, notify_email]

jobs:
  send-report:
    fsm:
      initial: idle
      states:
        idle: { on: { send-report: { target: build } } }
        build:
          entry:
            - type: agent
              agentId: report-builder
              prompt: "Build report {{inputs.report_id}}"
              outputTo: report
            - type: emit
              event: DONE
          on: { DONE: { target: send } }
        send:
          entry:
            - type: agent
              agentId: emailer
              inputFrom: report                   # chained doc
              prompt: "Send to {{inputs.notify_email}}"   # still resolves
          type: final
```

Collisions: if a chained doc id matches a signal-payload key, the chained data wins. Pick distinct names.

## Crossing session boundaries

`inputFrom` only reads documents in the current FSM session. Every signal fires a fresh session with an empty doc store — a job triggered by signal B cannot `inputFrom` a document produced by a prior session of signal A.

Pass the data on the signal payload. Declare the fields the next job needs in the signal `schema`; the caller (chat agent, webhook) includes them when firing the signal. The runtime auto-seeds `prepareResult.config` from the payload, so action prompts can reference `{{inputs.<field>}}` directly — no `inputFrom` wiring.

```yaml
signals:
  apply-actions:
    provider: http
    config: { path: /apply-actions }
    schema:
      type: object
      properties:
        actions: { type: string }
        items:   { type: string }
      required: [actions, items]

jobs:
  apply-actions:
    triggers: [{ signal: apply-actions }]
    fsm:
      initial: idle
      states:
        idle:
          on: { apply-actions: { target: act } }
        act:
          entry:
            - type: agent
              agentId: action-agent
              prompt: |
                Apply {{inputs.actions}} to {{inputs.items}}.
          type: final
```

`type: user` Python agents that call `parse_input(prompt, MyDataclass)` see the wrapped shape `{ "config": { ... } }` rather than the fields at the top level. Either keep `{{inputs.<field>}}` interpolation in the action prompt as above, or unwrap `config` in the agent before typing — see `writing-friday-python-agents` → `references/input-parsing.md` for the snippet.

For data too large for the payload, persist with the artifact + memory pattern — producer calls `artifacts_create` then `memory_save` to record the id; consumer reads the id from injected memory and calls `artifacts_get`. See the `writing-to-memory` skill.

## Conditional branching

Transition array with guard functions. Guards checked in order; first passing guard wins. Always include fallback.

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
          - target: path-default
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

Validator returns `errors` (blocks publish) and `warnings` (advisory).

### Errors

| Code | Path | Fix |
|---|---|---|
| `unknown_tool` | `agents.X.config.tools[N]` | Add `serverId/` prefix for MCP tools; check spelling for built-in tools |
| `unknown_agent_id` | `jobs.Y.fsm.states.Z.entry[N].agentId` | Declare agent in `agents` before job; check spelling |
| `unknown_memory_store` | `agents.X` | Add memory to `memory.own` or `memory.mounts` |
| `fsm_structural_error` | `jobs.Y.fsm.<path>` | Verify `initial` exists, all `on` targets exist, no `type: action` (use `entry` array) |
| `invalid_type` | (varies) | Read `message` field for expected vs received type |

### Warnings

| Code | Ignore when | Fix when |
|---|---|---|
| `orphan_agent` | Agent referenced inside valid FSM `entry` — validator skips malformed FSMs during cross-check. Fix FSM first. | Agent genuinely unused — wrap in job or delete. |
| `dead_signal` | Signal reserved for future use or external callers. | Signal genuinely orphaned — add job trigger or delete. |
| `missing_tools_array` | Agent has `tool_choice: none` or needs no tools. | Agent should call tools — add `tools` array. |
| `cron_parse_failed` | Never ignore. | Fix expression; use `crontab.guru` to validate. |
| `http_path_collision` | Never ignore. | Change one signal's `config.path` to unique route. |

## Runtime anti-patterns

Pass validation but fail or misbehave at runtime.

### `execution:` instead of `fsm:`

Config schema accepts `execution:` for backward compat, but runtime **only executes FSM jobs**. Non-FSM jobs silently skipped.

Symptom: `"No FSM job handles signal '<name>'"`

Fix: Rewrite as `fsm:` with `initial` and `states`.

### Atlas agent silently ignoring MCP tools

`type: atlas` agents self-contained — they ignore `tools` array. Adding `tools: ["google-gmail/send_gmail_message"]` to `atlas` agent = silently ignored. Bundled agent runs hard-coded behavior.

Symptom: Agent completes without error, but MCP tool never called. Output shows bundled agent default behavior (e.g., SendGrid instead of Gmail, generic web search instead of GitHub API).

Fix: Change to `type: llm`, set `config.provider` and `config.model`, move prompt into `config.prompt`, keep `tools` array. Or drop `tools` array entirely and let bundled agent handle domain.

### Initial state with no signal handler

`initial` state must handle trigger signal name in `on` map. Without it, signal silently ignored.

Symptom: Job triggers but produces no output, no error, no session.

Fix: Add `on: { <signal-name>: { target: <work-state> } }` to initial state.

### Non-final state with no outgoing transitions

FSM engine catches this in `validateFSMStructure`, but workspace config validator does not validate FSM internals (fsm is `z.any()` in `JobSpecificationSchema`).

Symptom: FSM reaches stuck state, session hangs.

Fix: Add transitions to every non-final state, or mark `type: final`.

### `type: action` in states

FSM engine supports `agent`, `llm`, and `emit` action types. `type: action` is legacy pre-FSM shape.

Symptom: `fsm_structural_error` at MCP-registry validator (second validation layer).

Fix: Use `entry: [ { type: agent, agentId: ... } ]`.

### Emit / transition name mismatch

`emit` action sends event to FSM engine. Transition must match emitted event name exactly.

```yaml
entry:
  - type: emit
    event: DONE
on:
  DONE: { target: completed }   # matches
```

Emit `COMPLETE`, transition on `DONE` = event queued, never consumed.

Symptom: Agent runs but session never completes.

Fix: Match emit event name to `on` key exactly.

### Missing `outputTo` in pipelines

Without `outputTo`, agent result not saved as document. Next step's `inputFrom` has nothing to read.

Symptom: Second agent receives empty or undefined input.

Fix: Add `outputTo: <doc-id>` to producer and `inputFrom: <same-doc-id>` to consumer.

### `inputFrom` reaching across sessions

`inputFrom` only sees documents from the current FSM session. A separate signal starts a fresh session with an empty doc store — `inputFrom: foo-result` referring to a document produced by another job's session resolves to "(none)" and the session fails before the agent runs.

Symptom: `Signal '<name>' session failed: inputFrom: document '<id>' not found. Available documents: (none)`.

Fix: pass the data on the signal payload — see "Crossing session boundaries".

## Order of declaration

Build workspace in this order:

1. **Agents first** — jobs reference `agentId` in FSM `entry` actions.
2. **Jobs second** — wire agents into orchestration layer.
3. **Signals last** — external entry points; nothing else depends on them.

Validator catches `unknown_agent_id` when job references missing agent.

## Stuck-recovery heuristic

Validation fails 3+ times on same operation:

1. Build **minimum viable config** (`version: "1.0"` + `workspace.name`), confirm validates cleanly.
2. Add **one section at a time** in order: signals → agents → jobs.
3. Call `validate_workspace` after each addition.
4. **First section that breaks** = debug target. Fix before adding next.

Removes panic-driven shotgun debugging producing orphaned agents, malformed FSMs, circular retries.

## Assets

- `assets/minimal-job-template.yml` — drop-in single-agent job. Copy, rename, publish.
- `assets/multi-step-job-template.yml` — chained agent pipeline with `outputTo` → `inputFrom` wiring.

## Companion skills

- `writing-workspace-signals` — Signal authoring: JSON Schema payloads, provider configs, HTTP path collisions, cron validation. Load before creating or editing any signal that accepts parameters or needs webhook endpoint.
- `workspace-api` — Workspace building workflow: draft mode, CRUD, validation, reachability model, tool selection.
- `writing-to-memory` — Artifact + memory reference pattern for the cross-session bridge described above. Load when a job needs to hand large or persistent data to a later session.
