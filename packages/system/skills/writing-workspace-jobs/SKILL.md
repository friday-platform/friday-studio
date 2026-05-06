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

Two places declare tools, with different naming rules:

- **`agents.*.config.tools`** (`type: llm` agent declared at workspace top
  level): use `serverId/toolName` for workspace MCP tools. Validator
  accepts prefixed tools for declared servers even when server offline.
- **FSM action `entry[].tools`** (per-action allowlist on `type: llm` /
  `type: agent`): same rule for workspace MCP tools — `serverId/toolName`.
  **Atlas-platform built-ins (`fs_glob`, `fs_read_file`, `fs_write_file`,
  `memory_save`, `memory_read`, `artifacts_create`, `parse_artifact`,
  `display_artifact`, `request_tool_access`, etc.) use bare names** —
  atlas-platform is auto-injected, no prefix needed.

| `list_mcp_tools` returns | Write in agent or action `tools` |
|---|---|
| `"search_gmail_messages"` (workspace MCP) | `"google-gmail/search_gmail_messages"` |
| `"get_gmail_message_content"` (workspace MCP) | `"google-gmail/get_gmail_message_content"` |
| Atlas-platform built-in | `"memory_save"`, `"fs_glob"`, etc. — no prefix |

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

Caller sees (SSE `job-complete` event, modern shape):

```json
{
  "status": "completed",
  "sessionId": "...",
  "artifactIds": ["art-abc", "art-def"],
  "summary": "Searched index; found 12 matches. Top result archived.",
  "output": [
    { "id": "search-result", "type": "AgentResult", "data": { ... } }
  ]
}
```

`artifactIds` are JetStream-persisted refs to each non-plumbing FSM document the job produced. `summary` is a short human-readable digest synthesized from `aiSummary` (preferred) → terminal-state action's `summary` field → truncated `outputTo` data (fallback).

**The supervisor (workspace-chat) prefers `artifactIds` + `summary` over `output` when both are present** — the LLM-visible tool result drops `output` entirely so the supervisor's next-turn input doesn't ingest the full Document[]. If the LLM needs an artifact's contents, it calls `parse_artifact(<id>)`.

You can declare a per-action `summary` on `type: llm` and `type: agent` actions to override the synthesized digest with author-controlled prose:

```yaml
- type: agent
  agentId: search-agent
  outputTo: search-result
  summary: "Index search across the knowledge base; returns top-scored matches."
```

**Verify after publish.** Fire the signal once with a fixture payload (`POST /api/workspaces/:id/signals/:signalId` with a JSON body) and confirm `artifactIds` is non-empty before declaring the workspace done. Empty `artifactIds` (or empty legacy `output`) means the data never reached the caller — almost always a missing `outputTo`.

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

**Currently agent-level, not FSM-level.** Guards and code-action helpers were
removed from the FSM engine; transitions take the first matching event without
predicates. To branch on data, decide and act inside a single agent, or chain
agents that each handle their own branch.

The simplest pattern: a single LLM agent that reads inputs, decides the path,
and acts in one step.

```yaml
fsm:
  initial: idle
  states:
    idle:
      on:
        go: { target: route-and-act }
    route-and-act:
      entry:
        - type: agent
          agentId: router-agent
          prompt: |
            Decide the path (A, B, or default) from the inputs and execute it
            yourself. Save the chosen path + outcome to memory.
          outputTo: decision
      type: final
```

For coarser routing where you really need separate states (e.g. each path
runs a *different* SDK agent), wire the router agent to write its choice to a
memory store, then have downstream supervisors read that store and dispatch.
This is the same pattern chat uses to coordinate multi-step work without FSM
guards.

### LLM router → Python user agent dispatcher

When the routing decision is a judgment call (LLM) but the per-branch work is
deterministic (fixed transforms, schema-constrained tool calls), pair an LLM
router with a `type: user` Python SDK agent. The LLM emits a structured
decision document; the Python agent reads it via `inputFrom` and dispatches
mechanically.

Workspace shape:

```yaml
agents:
  router:
    type: llm
    config:
      provider: anthropic
      model: claude-sonnet-4-6
      prompt: |
        Classify the inbox item by intent: "billing", "support", or "other".
        Emit a routing-decision doc.

  dispatcher:
    type: user
    agent: dispatcher-py    # registered Python SDK id
    # No tools array — type: user agents resolve tools via ctx.tools.call

jobs:
  triage-and-dispatch:
    triggers:
      - signal: triage-now
    fsm:
      initial: idle
      documentTypes:
        routing-decision:
          type: object
          properties:
            path:    { type: string, enum: ["billing", "support", "other"] }
            item_id: { type: string }
          required: [path, item_id]
      states:
        idle:
          on: { triage-now: { target: route } }
        route:
          entry:
            - type: agent
              agentId: router
              outputTo: routing-decision
              outputType: routing-decision
            - type: emit
              event: DONE
          on: { DONE: { target: dispatch } }
        dispatch:
          entry:
            - type: agent
              agentId: dispatcher
              inputFrom: routing-decision
          type: final
```

`agent.py` (registered separately via `POST /api/agents/register`):

```python
from friday_agent_sdk import agent, Context
from dataclasses import dataclass

@dataclass
class RoutingDecision:
    path: str
    item_id: str

@agent(id="dispatcher-py", version="0.1.0")
async def dispatcher(ctx: Context, prompt: str) -> str:
    # parse_input unwraps the FSM's wrapped {config: ...} shape; see the
    # writing-friday-python-agents skill for details.
    decision = ctx.parse_input(prompt, RoutingDecision)

    if decision.path == "billing":
        # Mechanical dispatch: known tool, known shape.
        result = await ctx.tools.call(
            "google-gmail/batch_modify_gmail_message_labels",
            {"message_ids": [decision.item_id], "add_label_ids": ["LABEL_BILLING"]},
        )
        return f"Routed {decision.item_id} to billing"

    if decision.path == "support":
        result = await ctx.tools.call(
            "linear/create_issue",
            {"title": "Support ticket", "external_id": decision.item_id},
        )
        return f"Routed {decision.item_id} to support"

    # default
    return f"No action for {decision.item_id}"
```

When this is the right shape:
- The LLM's only job is the classification (one decision per item).
- The dispatcher's branches are mechanical (no `ctx.llm.generate` calls).
- The Python agent is registered ahead of time — see the
  `writing-friday-python-agents` skill for the registration two-step
  (`POST /api/agents/register` then `upsert_agent`).

When NOT this shape — keep the work in one LLM action:
- Each branch's body itself needs LLM judgment (drafting different
  responses per category, scoring tradeoffs). Hybrid is overkill — a
  single LLM action with the full tool surface is simpler and the
  per-action `tools:` allowlist still locks it down.

> Note: predicate-on-transition is **not** on the roadmap. Agent-level
> branching is the intended forward path — the LLM action is more
> expressive than any guard expression we'd ship, and the supervisor-flip
> world means a routing agent can read context and dispatch via
> `delegate` without holding the items in its own buffer.

## Per-action tool + skill allowlist

`type: llm` and `type: agent` actions take optional `tools: [...]` and
`skills: [...]` arrays — both runtime-enforced. They narrow the catalog
**within** a single action, on top of any per-agent or workspace-level
filtering.

```yaml
- type: llm
  provider: anthropic
  model: claude-sonnet-4-6
  tools:
    - fs_glob               # atlas-platform built-in (bare)
    - google-gmail/search_gmail_messages  # workspace MCP (prefixed)
  skills:
    - composing-emails       # only this skill loadable here
  outputTo: triage
  prompt: |
    ...
```

Semantics:
- `tools: []` (empty array) — no MCP/platform tools available; only the
  auto-injected built-ins (memory + artifacts; see below). Useful for a
  pure-reasoning action.
- `tools: [...]` (populated) — exactly those tools, plus the built-ins.
- `tools` absent — inherits the agent/workspace tool surface, which may
  itself be permissive.
- `skills: []` — `load_skill` registered but resolves to "no skills
  available." Locks the action down.
- `skills: [...]` — whitelist within the job's resolved skill set.
- `skills` absent — full job-level skill visibility.

**Phase 1 made these load-bearing.** Pre-fix the runtime ignored both
fields and exposed the full catalog. If a fetcher action lists no send
tool but the prompt is ambiguous, the agent now genuinely cannot send.

## Auto-injected built-ins for FSM `type: llm` actions

You do **not** need to declare these in the action's `tools:` array;
they're always available:

- Memory: `memory_save`, `memory_read`, `memory_remove`
- Artifacts: `artifacts_create`, `artifacts_get`, `parse_artifact`,
  `display_artifact`
- Filesystem (sandboxed): `fs_glob`, `fs_read_file`, `fs_write_file`,
  `fs_list_files`, `fs_grep`
- Permissions: `request_tool_access` (see below)

Recent memory entries auto-prepend to the action's prompt. Recent
session artifacts auto-inject as `<retrieved_content>` envelopes. No
boilerplate.

If you do declare `tools: [...]`, the built-ins still work — the
allowlist narrows the **non-built-in** catalog. To genuinely lock the
action down to "memory only," declare `tools: []`.

## Delegating to a sub-agent from an FSM action

`type: llm` actions can spawn a sub-agent via the `delegate` tool —
opt in by listing it:

```yaml
- type: llm
  tools:
    - delegate
  prompt: |
    For each item in {{inputs.items}}, delegate the per-item judgment
    to a sub-agent with the gmail tools it needs. Collect the answers
    and emit a structured summary.
```

The child runs in an isolated context — its tool calls don't pollute
the parent action's message buffer. The parent sees only the child's
final `answer` (and the chunk stream for live UI). Bounded by:

- **`max_depth`** — default 1; child cannot itself call `delegate`.
- **`max_steps_per_call`**, **`max_output_tokens`**, **`max_input_tokens`**,
  **`max_wall_time_ms`** — workspace-level (`delegation:` block) +
  per-job override (`jobs.<name>.delegation:`). Budget exhaustion
  returns `{ ok: false, reason: "budget_exhausted: <which>" }` — the
  parent can fail-step or route around.

**When to delegate from an FSM action vs. compose with `inputFrom`:**
- Per-item expansion that would explode the parent's context →
  `delegate`. The child holds the items; the parent gets a digest.
- Sequential pipelines (fetch → format → emit) → chain states with
  `outputTo` → `inputFrom`. No delegation needed.

## Requesting access to a tool not in your allowlist

When an action discovers it needs a tool it didn't declare, the action
calls `request_tool_access(toolName, reason)`. Two paths:

- **Bypass on** (job or workspace `permissions.dangerouslySkipAllowlist:
  true`, or daemon `FRIDAY_DANGEROUSLY_SKIP_PERMISSIONS=1`): tool
  returns `{ ok: true, granted: true, reason: "bypass" }` synchronously.
  Action proceeds.
- **Bypass off** (default): tool returns `{ ok: false, granted: false,
  elicitationId, reason: "pending_user_approval" }`. The runtime
  emits a tool-allowlist elicitation surfaced via the Activity page +
  `GET /api/elicitations`. The action should `failStep` or route around;
  the user re-runs the job after answering.

```yaml
- type: llm
  tools:
    - fs_read_file
    - request_tool_access
  prompt: |
    If you discover you need fs_write_file (not in your allowlist), use
    request_tool_access first. Acknowledge the elicitation id to the
    user and stop — they will re-run the job after approving.
```

Authoring rule: only list `request_tool_access` in the allowlist when
the action has a known fallback path (failStep, partial result, retry
on next signal). The runtime suspend/resume layer is a follow-on; today
the user re-runs after answering.

**Per-job elicitation timeout.** Defaults to the parent job's `config.timeout`
(elicitations expire when the job times out). Override per-job to constrain
finer:

```yaml
jobs:
  triage:
    config:
      timeout: 30m
    elicitations:
      timeout: 5m   # individual prompts shouldn't sit unanswered
```

Expired elicitations move to a read-only Activity log entry; acting on
one does not reify the timed-out job.

## Runtime invariants you don't author

A few behaviors fire automatically. You don't opt in or out, but
knowing they exist saves debugging time.

- **Oversized tool results auto-lift to artifacts.** When an MCP tool
  returns more than ~4 KB, the runtime writes it to the JetStream
  Object Store and replaces the value in the action's message buffer
  with `<artifact-ref:...>`. If you see unexpected artifacts in
  `GET /api/artifacts?sessionId=...`, this is the source. Don't try to
  manage it manually.
- **Validator skips on tool-passthrough.** The hallucination judge
  runs only when the action's output is LLM-generated prose. If the
  output is empty or trivially echoes a tool result, the validator
  skips with a "Skipping validation for tool-passthrough trace" debug
  log. This halves validator cost on multi-step jobs and is why pure
  fetcher actions complete fast.
- **Provenance metadata is captured.** Every spawned session carries
  `parentSessionId` + `parentEventId`; every `step:complete` event has
  `usage: { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens,
  model }`. You don't write these — but the Activity / sessions API
  surfaces them, and crystallization (future) reads them.

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
