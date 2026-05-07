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
- [ ] Every LLM-backed `outputTo` action has a `complete` output contract (`outputType` schema args, or `{ response }` when untyped)

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

**Mechanical output contract:** every LLM-backed action with `outputTo` must finish by calling the runtime-injected `complete` tool. If the action declares `outputType`, `complete` args must match that document schema. If it does not, emit the full final text as `complete({ response: "..." })`. Do not rely on prose after the last MCP/tool call; if `complete` is not called, the session fails instead of persisting an empty/stub document.

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

`artifactIds` are JetStream-persisted refs to each non-plumbing FSM document the job produced. `summary` is a short human-readable digest synthesized from `aiSummary` (preferred) → terminal-state action's `summary` field → structural digest of `outputTo` data (fallback). See "Writing artifact summaries the supervisor can answer from" below for guidance on making the summary self-sufficient.

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

For large data **inside the same FSM session**, prefer `outputTo` → `inputFrom`; the runtime stores bulky documents as artifact refs and hydrates those refs before the next action runs. For data that must cross session boundaries, persist with the artifact + memory pattern — producer calls `artifacts_create` then `memory_save` to record the id; a later session reads the id from memory and calls `parse_artifact`. See the `writing-to-memory` skill.

## Single-action FSMs post-supervisor-flip

Default to **one LLM action per job** when the work is "fetch some
context, then emit a result." The two-state `fetch → format` shape
(action A pulls structured data into `outputTo: foo-result`; action B
takes `inputFrom: foo-result` and reformats it as the user-visible
markdown) is a pre-supervisor-flip pattern — it doubled the LLM calls
for no behavioral gain.

Post-flip the supervisor (workspace-chat) is the consumer. It already
sees `{ artifactIds, summary }` from the terminal action and renders
the artifact body verbatim to the user. The second pass is wasted
latency + tokens + a validator-judge LLM call.

### When to collapse

Collapse two states into one when **all** are true:

- Both actions run the same kind of work (LLM with tools).
- The first action's only consumer is the second action — no other
  branch reads `outputTo: foo-result`.
- The second action's only job is reformat / re-summarize the first's
  output. No new tool calls beyond cosmetic ones.
- The terminal output is what the user (via the supervisor) consumes.

### When NOT to collapse

Keep the two-state shape when **any** is true:

- A genuine fan-in: the second action takes `inputFrom: [a-result, b-result]`
  combining outputs from parallel branches.
- The first action's output is also persisted for cross-session reuse
  (a different job's signal payload references it later).
- The two actions need independent budgets, allowlists, or models —
  e.g. cheap-Haiku fetcher feeding paranoid-Opus drafter.
- The first action's tools are mutating and you want a separate
  read-only formatter to render the result safely.

### Worked example

Before — two states, two LLM calls (~24s of redundant work on a real run):

```yaml
fsm:
  initial: idle
  states:
    idle:
      on:
        review-inbox: { target: fetch }
    fetch:
      entry:
        - type: agent
          agentId: inbox-fetcher       # gmail search + batch get
          outputTo: emails-result
        - type: emit
          event: DONE
      on:
        DONE: { target: review }
    review:
      entry:
        - type: agent
          agentId: inbox-reviewer      # reformat JSON as markdown
          inputFrom: emails-result
          outputTo: review-result
      type: final
```

After — one state, one LLM call. The terminal action both fetches
AND emits the user-visible markdown:

```yaml
fsm:
  initial: idle
  states:
    idle:
      on:
        review-inbox: { target: review }
    review:
      entry:
        - type: agent
          agentId: inbox-reviewer      # fetch + format in one prompt
          outputTo: review-result
      type: final
```

The merged agent's prompt is two short sections: "Step 1 — fetch"
(declares the tools and call shape) and "Step 2 — emit" (declares the
markdown shape and "no prose before or after"). Tools list is the
union of what both agents needed; declared output is what the user
sees.

### Verify after collapse

Re-fire the signal once. Confirm:

- `output[0].id` is unchanged (still `review-result`); supervisor
  consumers keep working.
- `summary` reads sensibly without `parse_artifact` — the auto-derived
  digest from the markdown is the supervisor's first-pass view.
- `step:complete.validation.strategy` resolves to `skip` (the
  classifier sees only read-only tools + structured `outputType`, or
  no `outputType` + no mutating tool) — no validator-judge LLM call.

If the auto-derived `summary` is too thin, set `summary:` on the
action explicitly rather than reintroducing a second formatter step.

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
they're **always** available regardless of what you put in `tools:`.
The `tools:` field narrows MCP-server tools (workspace-declared
external integrations); platform tools are ambient and not subject to
that narrowing.

**Memory** — `memory_save`, `memory_read`, `memory_remove`.
**Artifacts** — `artifacts_create`, `artifacts_get`, `artifacts_update`,
`artifacts_delete`, `artifacts_get_by_chat`, `parse_artifact`,
`display_artifact`.
**Filesystem** — `fs_read_file`, `fs_write_file`, `fs_list_files`,
`fs_glob`, `fs_grep`. **Working directory: relative paths resolve
to the workspace dir** (`~/.atlas/workspaces/<workspaceId>/`).
Absolute paths still work but pin the file outside the workspace —
prefer relative for portability and so `git`-style backups capture
your output.
**Shell + data** — `bash`, `csv`, `webfetch`. `bash` is workspace-CWD-
scoped (same default as `fs_write_file`).
**State** — `state_append`, `state_filter`, `state_lookup`.
**Permissions** — `request_tool_access` (see below).
**Skills** — `load_skill` (loads a versioned skill body into context).
**Delegation** — `delegate` (spawn a sub-agent — see "Delegating to a
sub-agent from an FSM action" below).

Recent memory entries auto-prepend to the action's prompt. Recent
session artifacts auto-inject as `<retrieved_content>` envelopes. No
boilerplate.

If you declare `tools: [...]`, the built-ins still work — the
allowlist narrows the **MCP-server** catalog only. To genuinely lock
an action down to "memory only," you can't (today) — the platform
tool surface is fixed. Long-term: a `platform_tools: [...]` opt-in is
on the roadmap (see pt3 N7-followup).

### Output contract: `complete` is the only durable emission for `outputTo`

When an LLM-backed action has `outputTo`, the runtime injects a
`complete` tool and treats that call as the action's durable output.
This is true even when `outputType` is omitted:

- With `outputType: <DocumentType>`, call `complete` with fields that
  match the declared document schema.
- Without `outputType`, call `complete({ response: "<full final text>" })`.
- If the action also has MCP tools, the runtime uses `toolChoice: "required"`
  until `complete` appears, so the model cannot stop with prose after a
  search/write/memory call.

Do **not** end an `outputTo` action on `record_validation`, `fs_write_file`,
`memory_save`, or any other non-`complete` tool. Those calls may be useful
side effects, but they are not the output document. If `complete` is missing,
the session fails with `LLM action with outputTo '<id>' did not call complete`
rather than persisting an empty `{ response: "" }` stub.

Preferred pattern for reports: call any tools needed, write auxiliary files if
useful, then `complete` with a compact structured/report payload containing the
report path/ref, counts, and summary. The supervisor sees the compact
`{ artifactIds, summary }` job result first and only calls `parse_artifact` when
it needs the full body.

## Validation strategies

Every `type: llm` and `type: agent` action's output is checked for
fabrication unless the author opts out. The `validate:` field selects
the strategy. Absent or `"auto"` → the runtime classifier picks
`skip` or `self` based on the action's shape; authors override only
when they need different behavior.

### String forms

```yaml
validate: skip      # bypass — read-only fetchers, deterministic transforms
validate: self      # LLM self-checks its draft before emitting (cheap)
validate: external  # separate-judge LLM call after emit (thorough, slower)
validate: auto      # runtime decides based on action shape (default)
```

### Auto-detect rules

The classifier (see `READ_ONLY_ALLOWLIST` and `MUTATING_VERB_RE` in
`packages/fsm-engine/validate-classifier.ts` for the canonical lists)
picks:

- **`skip`** when every declared tool is read-only (`gmail/get_*`,
  `gmail/search_*`, `fs_read_file`, `web_fetch`, `memory_read`,
  `artifacts_get`, etc.) **and** the action has structured
  `outputType:`. Also picks `skip` for the pure-formatter case:
  no tools, has `inputFrom:`, has `outputType:`.
- **`self`** when any declared or called tool is mutating (`send_*`,
  `create_*`, `delete_*`, `batch_modify_*`, `fs_write_*`,
  `memory_save`, `memory_remove`, `publish_*`, etc.) **or** the
  action emits free-form prose with no structured contract.
- **`external`** is never auto-picked. Authors opt in explicitly.

`type: agent` actions resolving to `type: user` or `type: atlas`
agents short-circuit to `skip` — those agents are deterministic
from the FSM's perspective.

### Object form

For advanced overrides, swap the string for an object. Object form
pins `strategy` to `self` or `external` (use the string form for
`skip` / `auto`):

```yaml
validate:
  strategy: external
  skill: "@my/financial-claims-validator"   # custom validation skill
  threshold: paranoid                       # supervision threshold
  retryOnFail: false                        # advisory verdicts pass through
```

`threshold` accepts `minimal`, `standard`, or `paranoid` — sets the
confidence band the judge must clear. `retryOnFail: false` lets
`uncertain` / `fail` verdicts proceed as advisory rather than
blocking the step.

### What each strategy does at runtime

- **`skip`** — no validation. `step:complete.validation` records
  `{ strategy: "skip", skipReason }` for observability.
- **`self`** — runtime composes `@friday/validating-llm-outputs`
  (or your `skill:` override) into the action's prompt when the
  action does not already have a mechanical `complete` output
  contract. The LLM walks every claim in its draft and drops anything
  not sourced to a tool result, input, or direct inference, then calls
  `record_validation`. For `outputTo` actions, `complete` owns output
  emission and validation is recorded as step metadata; do not try to
  make `record_validation` the produced document.
- **`external`** — post-emit judge call. Returns a
  `ValidationVerdict` with `status` (`pass` / `uncertain` /
  `fail`), `confidence`, `threshold`, and an `issues` array with
  `category` (`sourcing`, `no-tools-called`, `judge-uncertain`,
  `judge-error`), `severity`, `claim`, `reasoning`, and `citation`.
  See `packages/hallucination/src/verdict.ts` for the full shape.

### When to override the default

Three cases worth the explicit field:

```yaml
# 1. Known-deterministic action — LLM is just formatting structured input.
- type: llm
  provider: anthropic
  model: claude-sonnet-4-6
  inputFrom: raw-event
  outputType: formatted-event
  validate: skip
  prompt: "Reshape the event into formatted-event."
```

```yaml
# 2. High-stakes action — independent review is worth the latency.
- type: agent
  agentId: contract-drafter
  outputTo: contract-draft
  validate: external
```

```yaml
# 3. Domain-specific self-check — pair self with a custom validator.
- type: llm
  provider: anthropic
  model: claude-sonnet-4-6
  outputTo: medication-plan
  validate:
    strategy: self
    skill: "@my/medical-claims-validator"
  prompt: |
    Draft a medication plan from the patient summary above.
```

### Cross-references

- `@friday/validating-llm-outputs` is a **system skill** the runtime
  composes into the action prompt when `validate` resolves to
  `self`. Authors don't load it via `load_skill`.
- For workspace-wide / per-job defaults, see the `validation:`
  section in `@friday/workspace-api` — covers the workspace and
  job-level block, full precedence chain (action > job >
  workspace > `"auto"`), skill override, and real-world configs.

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

## Parallelizing per-item work via delegate fan-out

Per-item workloads (triage N emails, classify N tickets, score N
candidates) that today run sequentially in one LLM action collapse
to roughly the cost of a single batch when you fan out via
`delegate`. The parent emits one action that spawns K children in
parallel; each child handles a chunk of items in its own isolated
context; the parent aggregates only the final summaries. Target on
N>10 per-item workloads: ~70% wall-time reduction vs. the
single-action sequential shape.

### When to fan out

- **N > ~10 items**, and per-item work is independent (no item
  reads another item's output).
- **Item ordering doesn't matter** — children run concurrently and
  return in arbitrary order.
- **Per-item work is non-trivial** (each item needs LLM judgment +
  ≥1 tool call). For pure-formatting passes, the per-call delegate
  overhead exceeds the benefit.

Don't fan out when:
- N ≤ ~5 — sequential is faster end-to-end (single context warmup,
  no aggregation step).
- Items are dependent (item N's classification depends on items
  1..N-1) — must run sequential.
- Per-item work is sub-second (overhead dominates).

### The pattern

One `type: llm` parent action lists `delegate` in its `tools`. The
prompt instructs the LLM to chunk the input into K batches and call
`delegate` K times in parallel — modern LLMs (Claude Sonnet 4.6+)
emit parallel `tool_use` blocks in a single turn, so the K children
run concurrently. Each child runs in an isolated context with its
own tool allowlist; the parent's message buffer only sees each
child's final `answer`. The parent then emits one structured
aggregate doc.

### Worked example: triage 50 emails as 5 delegates of 10 each

```yaml
agents:
  triage-fanout:
    type: llm
    config:
      provider: anthropic
      model: claude-sonnet-4-6
      prompt: |
        You receive a list of N emails on the signal payload. Your
        job: classify and act on each one.

        If N > 10, split the list into batches of ~10 and call
        `delegate` once per batch IN PARALLEL (emit all delegate
        tool_use blocks in a single response — do not await one
        before issuing the next). Each child receives one batch and
        the same per-item instructions; it returns a JSON digest of
        per-email outcomes.

        After all children return, aggregate their digests into one
        structured `triage-summary` doc: total processed, counts by
        outcome, ids of items needing manual review.
      tools:
        - delegate
        - google-gmail/search_gmail_messages       # for the parent's pre-scan
      delegation:
        # Child tool surface — children inherit parent allowlist
        # plus these. Per-child budgets enforced by the runtime.
        child_tools:
          - google-gmail/get_gmail_message_content
          - google-gmail/batch_modify_gmail_message_labels

jobs:
  auto-triage:
    triggers:
      - signal: triage-now
    delegation:
      max_depth: 1               # children cannot themselves delegate
      max_steps_per_call: 12     # ~10 items + a couple of tool retries
      max_input_tokens: 40000    # bounded per child
      max_output_tokens: 4000    # digest only, not per-email prose
      max_wall_time_ms: 60000    # 60s per child; runaway → clean failure
    fsm:
      initial: idle
      states:
        idle:
          on: { triage-now: { target: fanout } }
        fanout:
          entry:
            - type: agent
              agentId: triage-fanout
              outputTo: triage-summary
              outputType: triage-summary
          type: final
```

Children inherit workspace validation defaults (see "Validation
strategies" above). Each child's mutating Gmail call gets the same
`self`-validation pass it would have gotten in the sequential
shape; the runtime's auto-classifier picks per-action.

### Phase 8 budgets cross-reference

Each child runs under the resolved `delegation:` budget — workspace
default merged with per-job override (per-field, job wins). Knobs:

- `max_depth` — children can't recursively fan out (default 1).
- `max_steps_per_call` — agent loop iterations per child.
- `max_input_tokens` / `max_output_tokens` — token bounds per
  child.
- `max_wall_time_ms` — wall-clock cap per child. A runaway child
  returns `{ ok: false, reason: "budget_exhausted: max_wall_time_ms" }`
  to the parent, which can choose to record the failure in the
  aggregate or fail the step. The other children still complete.

Full schema and merge precedence: see the `delegation:` section in
the `workspace-api` skill.

### Validation defaults

Children inherit the workspace and job-level `validation:` config
the same way any FSM action does — see "Validation strategies"
above. The parent aggregator action is typically `validate: skip`
(deterministic merge of structured child digests into one doc); the
children's per-item mutating actions get `self` validation
automatically because they call `batch_modify_*` / `send_*` tools.

### Anti-patterns

- **Fanning out dependent work.** If item N needs item N-1's
  classification (e.g. dedupe across the batch), keep it
  sequential. Children can't see each other's state.
- **Sub-batch overhead.** Fanning out 4 items as 4 children of 1
  costs more than running 4 sequentially in one action — the
  per-child context warmup and aggregation round-trip dominate.
  Aim for chunks where per-child work is multiple seconds.
- **Unbounded fan-out.** Don't let the parent decide K from
  untrusted input — cap chunk size in the prompt, and rely on
  `delegation:` budgets as the runtime backstop. A 1000-item batch
  fanned out as 1000 children will exhaust the daemon, not finish
  faster.
- **Forgetting `outputType:` on the aggregate.** Without a
  structured contract, the parent emits free-form prose and the
  caller can't programmatically consume "what got triaged."

## Writing artifact summaries the supervisor can answer from

The supervisor (workspace-chat) sees `{ artifactIds, summary }` for
every job result and decides per turn whether to call `artifacts_get`
to load the full body. **A thin `summary:` forces the supervisor to
re-fetch on every follow-up question** — wasted tokens and a slower
turn. A summary that carries the structural facts up front lets the
supervisor answer common queries (counts, top items, status flags,
key URLs) without re-fetching.

### What "self-sufficient" means

Aim for the summary to answer the questions a user is most likely
to ask after the job completes. For a triage job that's "how many
urgent? what got drafted? what needs my review?" For a search job
it's "how many hits? top result?" The summary should be the cheapest
data-store the supervisor consults — anything that takes a fetch
should be the exception, not the default.

Include, in this priority order:

1. **Counts of the things that matter.** "8 urgent, 12 normal, 3
   drafts created" beats "Triaged the inbox and acted on the
   urgent items." Counts are how supervisors answer "did anything
   change?" and "is this done?".
2. **Top items by name/title/id.** A handful of identifying labels
   so the supervisor can answer "which ones?" without a fetch.
   Cap at ~5 — the summary isn't the artifact.
3. **Key URLs.** If the job published to Notion, opened a PR, or
   sent a calendar invite, the URL belongs in the summary. The
   supervisor may need it next turn to deep-link.
4. **Status flags.** A boolean `status: "ok"` / `error_count: 0`
   / `requires_attention: true` lets the supervisor answer
   "anything to flag?" without scanning a long body.
5. **One-line digest of what was done.** The classic prose summary
   is still useful — but as the *header*, not the *whole thing*.

### Worked example: triage job

Bad — supervisor must `artifacts_get` to answer anything:

```yaml
- type: agent
  agentId: triage-agent
  outputTo: triage-summary
  summary: "Triaged the inbox and took action on urgent items."
```

Good — supervisor answers "how many urgent?" and "what did you
draft?" from the summary alone:

```yaml
- type: agent
  agentId: triage-agent
  outputTo: triage-summary
  outputType: triage-summary
  summary: |
    Triaged 50 emails: 3 urgent (drafted replies), 12 normal (filed),
    35 noise (archived). Drafts await user review in Gmail.
    See artifact for per-email outcomes.
```

The structured `outputTo` document carries the per-email detail; the
`summary:` carries the answers to the supervisor's likely
follow-ups. Both ship to the supervisor on `job-complete`; only the
artifact body costs a `parse_artifact` round-trip.

### Auto-derived structural fingerprint

When you don't declare `summary:`, the runtime synthesizes one from
the terminal-state document's top-level fields. As of I3 the auto-
synthesis emits a structural digest rather than truncated JSON:

- Top-level array fields surface as `<key>: N items`.
- Top-level scalar fields (string/number/boolean) surface as
  `<key>: <value>`.
- Nested objects are skipped (too noisy at-a-glance).

So a doc like `{ status: "ok", actions: [...8...], flagged: [...3...] }`
auto-summarizes as `status: ok; actions: 8 items; flagged: 3 items`
— good enough for "how many?" without an author-provided string.

That said, the auto-derived digest is a *fallback*. When the answers
to likely supervisor questions need top item names or a URL, declare
`summary:` explicitly — the runtime can count arrays but doesn't
know which item names matter.

### Verify after authoring

After publishing the workspace, fire the signal once and inspect
the `summary` field on the SSE `job-complete` event:

- Does it answer "how many?" without a `parse_artifact`?
- Does it name the top items / surface a URL when relevant?
- Is it < 500 characters? (Hard cap is 5000; a summary much over
  500 chars usually means the artifact body leaked into it.)

If "no" to any of these, set `summary:` on the terminal action
explicitly. The `summary:` field is the contract you control to
keep the supervisor cheap.

## Requesting access to a tool not in your allowlist

When an action discovers it needs a real runtime-visible tool it didn't
declare, the action calls `request_tool_access(toolName, reason)`. Two paths:

- **Bypass on** (job or workspace `permissions.dangerouslySkipAllowlist:
  true`, or daemon `FRIDAY_DANGEROUSLY_SKIP_PERMISSIONS=1`): tool
  returns `{ ok: true, granted: true, reason: "bypass" }` synchronously.
  Action proceeds.
- **Bypass off** (default): the runtime creates a `tool-allowlist`
  elicitation surfaced in Activity/sidebar and **blocks the tool call**
  until the user answers, declines, or the elicitation expires. On allow,
  `request_tool_access` returns granted and the same action continues; on
  deny/expiry it returns a terminal denial that the action must handle.

Unknown tools are rejected without creating an elicitation. If
`request_tool_access` returns `reason: "unknown_tool"`, stop guessing: call
`list_capabilities` / `list_mcp_tools`, install/enable the correct server if
needed, or ask the user which real tool/provider they meant.

```yaml
- type: llm
  tools:
    - fs_read_file
    - request_tool_access
  prompt: |
    If you discover you need fs_write_file (not in your allowlist), call
    request_tool_access("fs_write_file", "Need to apply the requested patch").
    If granted, continue in this same action and finish with complete(...).
    If denied or expired, explain what was blocked and stop safely.
```

Authoring rule: only list `request_tool_access` when the action can continue
safely after an allow or produce a useful denial/partial result. Do not use it
as a way to ask for hallucinated tool names.

## Asking the user for a decision mid-job

Use `request_human_input` for generic user decisions, approvals, or
disambiguation — for example, choosing email actions, confirming which account
to use, or selecting between safe alternatives. It creates an `open-question`
elicitation in Activity/sidebar, blocks the current tool call, and returns the
answer to the same action.

```yaml
- type: llm
  outputTo: review-actions
  tools:
    - request_human_input
  prompt: |
    Present the choices, then call request_human_input with a clear question
    and options such as [{ label: "Archive", value: "archive" }, ...].
    After the tool returns { status: "answered", answer: ... }, finish with
    complete({ response: ... }). If declined or expired, stop safely.
```

Python `type: user` agents use the same primitive through
`ctx.tools.call("request_human_input", {"question": ..., "options": [...]})`.
Do not fake this by streaming a menu and hoping a later chat turn resumes the
FSM action; without `request_human_input`, an `outputTo` action must complete in
one execution and will fail if it waits for a future user message.

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

- **Oversized tool results and action documents auto-lift to artifacts.**
  When an MCP tool or `outputTo` document is bulky, the runtime writes it to
  the JetStream Object Store and carries compact refs/summaries at supervisor
  boundaries. Downstream same-session `inputFrom` actions are hydrated before
  the model sees them, so keep using `outputTo` → `inputFrom` instead of
  scraping session logs or re-fetching artifacts manually. If you see
  unexpected artifacts in `GET /api/artifacts?sessionId=...`, this is the
  source.
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

Fix: Add `outputTo: <doc-id>` to producer and `inputFrom: <same-doc-id>` to consumer. For LLM-backed producers, also make sure the action finishes with `complete(...)` (schema args when `outputType` is set, `{ response }` otherwise).

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
