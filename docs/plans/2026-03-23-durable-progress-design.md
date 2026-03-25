<!-- 2026-03-23 - Durable Progress & Inline Summaries -->

## Problem Statement

When the platform processes a user request, tool calls and reasoning are
ephemeral — they appear in a "Thinking..." collapsible during live execution
but are lost on reconnect and absent from historical session views. Users
reopening a completed session see less context than was available live. There
is no coherent, durable timeline of what the platform did during a conversation
turn.

Additionally, there is no high-level progress view that tells users "what's
happening" at a glance. Tool call details are too granular; users need a curated
summary of meaningful milestones (planning started, services connected,
workspace created).

## Solution

Enrich the existing event structure — no new event types, no parallel system.

1. **Inline collapsible groups** per assistant turn, containing the tool calls
   from that turn. While running, the label shows the latest tool call. On
   completion, a new `summarize_actions` tool provides a short, LLM-generated
   summary label that becomes the collapsible toggle text.

2. **Sidebar progress items** derived from tool calls that carry an optional
   `progress` field. The frontend filters for these and shows the last 5. No
   new backend pipeline — just a field on tool results that are milestone-worthy.

3. **Fully durable.** All data flows through the existing chat message stream.
   Tool calls are already streamed as message parts and persisted in
   conversation history. Works identically live and historical. Forward-only —
   no backfill of existing conversations.

## User Stories

1. As a user watching a conversation, I want to see a collapsible summary of
   what the platform did before each assistant message, so I understand the
   work that led to the response
2. As a user reopening a completed conversation, I want to see the same
   collapsible summaries that were visible live, so I can understand what
   happened without having watched it
3. As a user glancing at the sidebar, I want to see the last 5 high-level
   progress milestones (planning, connections, workspace creation), so I know
   what's happening without reading every tool call
4. As a user watching live execution, I want the collapsible label to update
   as tools execute (showing the latest tool), so I know the platform isn't
   stuck
5. As a user expanding a completed collapsible, I want to see the individual
   tool calls that happened during that turn, so I can debug or understand
   the details
6. As a developer, I want adding a new progress-worthy tool to be trivial
   (add a `progress` field to the tool result), so transparency scales without
   new infrastructure

## Implementation Decisions

### No new event types

All data rides on the existing chat message stream. Tool calls are already
streamed as message parts (`tool-call`, `tool-result`) to the frontend and
persisted as part of the conversation history. The summary and progress markers
are fields on tool call results, not new event variants.

### Summary tool (`summarize_actions`)

A new tool available to the conversation agent. The LLM calls it after
completing its tool calls and text response for a turn. It accepts:

- `summary: string` — short label, e.g. "Verified Linear and Slack access,
  created a plan"

The tool result streams as a `tool-result` message part like any other tool
call, and is persisted as part of the conversation history — making it
automatically durable. The frontend identifies it by tool name and extracts
the summary for the collapsible label.

Service icons (Linear, Slack, etc.) are derived by the frontend from the other
tool calls in the group — inspecting MCP server names and tool name prefixes.
No need for the LLM to specify icons explicitly.

The LLM is instructed (via system prompt) to call this tool after every turn
that involved tool calls. If it doesn't call it, the frontend falls back to
showing the latest tool call name as the label.

### Progress-worthy marker on tool results

Certain tool results gain an optional `progress` field:

```typescript
{
  progress?: {
    label: string    // Short, human-readable: "Connected to Linear"
    status: "active" | "completed" | "failed"
  }
}
```

Initial tools that emit progress:

- **`do_task`** — label like "Started planning" or "Creating workspace blueprint"
  (shorter than current verbose output). Requires a new field on the tool since
  current output is too detailed for a progress label.
- **Authentication/connection tools** — "Connected to {service}" on successful
  MCP server connection or credential verification.
- **Workspace creation** — "Workspace created" when a workspace is provisioned.

The sidebar filters all tool call message parts across the conversation for
entries with a `progress` field and displays the last 5.

### Inline collapsible grouping

Grouping is per assistant turn — all tool calls between the previous assistant
message and the next one form a single collapsible group. This is a frontend
rendering concern, not a backend grouping mechanism.

- **Live:** Label updates as each tool call completes (shows latest tool name).
  When the summary tool fires, label is replaced with the summary.
- **Historical:** Summary is already present in the persisted message parts.
  Label is set immediately from the summary tool result. If no summary exists,
  falls back to latest tool name.
- **Expandable:** Clicking the collapsible reveals individual tool calls with
  their inputs/outputs.

### Surfacing inner agent tool calls

Today, tool calls made by sub-agents inside `do_task` and `workspace-planner`
are invisible to the conversation stream. They're blocked at two layers:

1. **Session isolation** — sub-agents run in a separate task session
   (`parentSessionId-task-UUID`), so their events go to the task session
   handler, not the parent conversation writer.
2. **Event callback binding** — the FSM engine emits tool events to
   `sig._context?.onEvent`, which is bound to the task session, not the
   parent.

**This must change.** Inner tool calls (Notion searches, Slack posts, MCP
interactions) should be visible in the conversation as collapsible content.
Users need to see what the platform actually did, not just "Planning..." and
the final result.

The fix is to **forward inner tool call events to the parent conversation
writer**:

- In the `do_task` ephemeral executor, bridge a subset of inner events
  (tool call name + result pairs) back to the parent conversation's
  `UIMessageStreamWriter`. Not all FSM lifecycle events — just the tool
  calls that represent real work (MCP tool calls, resource reads/writes).
- Update the `streaming-signal-trigger.ts` allowlist to pass through a new
  event type for inner tool calls (e.g., `data-inner-tool-call`) or relax
  the `data-fsm-*` block for specific event subtypes.
- These forwarded events become message parts in the conversation, visible
  in both live and historical views.

The collapsible then contains:

- **Direct tools** (`connect_service`, `take_note`, `load_skill`,
  `fsm-workspace-creator`): Visible as individual message parts, as today.
- **Orchestrator tools** (`do_task`, `workspace-planner`): The top-level
  call, PLUS forwarded inner tool call events showing the actual MCP
  interactions (e.g., "notion: search pages", "notion: query database").
- **`data-tool-progress` parts**: Continue streaming for high-level phase
  updates ("Planning...", "Spinning up agents..."). These supplement the
  inner tool calls, not replace them.

### Conversation agent prompt changes

The conversation agent's system prompt is updated to instruct it to call
`summarize_actions` after completing tool calls in a turn. The summary should
be a concise, user-facing description of what was accomplished — not internal
reasoning.

### Backwards compatibility with existing conversations

Existing conversations have no `summarize_actions` tool calls and no `progress`
fields on tool results. The frontend must handle their absence gracefully:

- **Collapsible groups:** Always render a collapsible when an assistant turn
  contains tool calls — old and new conversations alike.
- **Collapsible label fallback:** If no `summarize_actions` result exists,
  fall back to a count-based label: "Used N tools" (e.g., "Used 3 tools").
  Simple, accurate, works for every conversation without special data.
- **Sidebar progress:** No tool calls with `progress` fields → sidebar progress
  section is empty / hidden. This is fine — older conversations never showed
  progress items.
- **`progress` field parsing:** Always optional, always guarded. Tool results
  without a `progress` field are the norm for all existing data.

The rule is simple: new UI elements are **additive and opt-in**. If the data
isn't present, the conversation renders exactly as it does today.

### What stays ephemeral

Reasoning tokens and streaming text deltas remain ephemeral during live
execution. Tool call results (including the summary tool) are persisted as part
of the conversation history and are available on reload.

## Testing Decisions

### What makes a good test

Tests verify that the right data appears in the right places in the existing
message structure. No new event pipelines to test — just new fields on existing
tool results and a new tool.

### Modules to test

- **`summarize_actions` tool** — Verify it accepts a summary string and returns
  a structured result. Verify the conversation agent calls it after tool-using
  turns (eval-level test).
- **Progress field on tool results** — Verify `do_task`, auth tools, and
  workspace creation emit the `progress` field with correct label and status.
- **Frontend collapsible rendering** — Verify groups are formed per assistant
  turn, summary is extracted from `summarize_actions` tool call, fallback to
  latest tool name when no summary exists.
- **Frontend sidebar** — Verify progress items are filtered from tool call
  message parts, last 5 shown, ordered by position in conversation.

### Prior art

Existing tests for tool call message part handling. Frontend tests for the
current `data-tool-progress` and `data-intent` rendering components.

## Out of Scope

- Backwards compatibility / backfilling existing sessions
- Resources section in sidebar
- Accounts section in sidebar (already works with existing events)
- Localization of progress labels
- Paired start/end progress events with duration tracking
- New event types or event pipeline changes
- `data-tool-progress` and `data-intent` deprecation (can happen separately)

## Further Notes

This design intentionally avoids the v3 plan's `status` event type. The
reviewer's core criticism was valid: introducing a parallel event system adds
complexity without proportional value. By enriching existing tool call results
and adding one summary tool, we get durable progress with zero new
infrastructure.

The `data-tool-progress` and `data-intent` patterns continue to work as-is.
They can be deprecated later once the new progress rendering is stable, or
kept for cases where ephemeral-only progress is appropriate.

The `progress` field convention is opt-in per tool. Adding progress to a new
tool is one field addition — no schema changes, no new event types, no
frontend pipeline changes. The sidebar just picks it up automatically.
