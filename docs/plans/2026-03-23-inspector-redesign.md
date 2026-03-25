# Inspector Redesign: Job Execution Debugger

## Problem Statement

The inspector page tries to be a workspace builder and a workspace runner
simultaneously, and does neither well. It has a generation bar, YAML loader,
mock mode, planning feed, and a 3-pane step drawer — all competing for
attention. After team review, the page misses the mark.

Users need a focused tool for one thing: take an existing job from a loaded
workspace, run it against real infrastructure, and see exactly what each agent
did. Chrome DevTools for agent pipelines.

## Solution

Strip the inspector to a single-purpose **job execution debugger** with five
vertical zones:

1. **Workspace + job selector** (top bar, URL-routed)
2. **Pipeline DAG** (existing canvas, reduced height during execution)
3. **Run controls** (signal payload form + Run button, real execution only)
4. **Waterfall timeline** (Chrome DevTools network-style agent execution bars)
5. **Agent inspection panel** (tabbed bottom panel: Overview | Input | Output | Trace)

The page lives at `/inspector` as a standalone tool. Deep-linkable from the
platform via `/inspector?workspace=X&job=Y`.

## User Stories

1. As a developer, I want to select a workspace and job from a dropdown, so that I can quickly target what I want to test
2. As a developer, I want the URL to reflect my workspace/job selection, so that I can bookmark and share specific test configurations
3. As a developer, I want to see the job's pipeline DAG, so that I understand the topology before running
4. As a developer, I want a clear input form generated from the signal schema, so that I can provide test payloads without guessing the shape
5. As a developer, I want a single prominent Run button, so that triggering execution is obvious and immediate
6. As a developer, I want the DAG to shrink when execution starts, so that the waterfall gets maximum screen space
7. As a developer, I want to see agent execution as horizontal bars on a shared timeline, so that I can see duration, sequencing, and parallelism at a glance
8. As a developer, I want waterfall bars to fill in live as agents execute, so that I can watch progress in real time
9. As a developer, I want to click a waterfall row to inspect that agent, so that I can drill into what happened
10. As a developer, I want an Overview tab showing agent name, duration, and status, so that I get the execution summary at a glance
11. As a developer, I want an Input tab showing the data the agent received, so that I can verify it got the right context
12. As a developer, I want an Output tab showing what the agent produced, so that I can verify correctness
13. As a developer, I want a Trace tab showing tool calls and live streaming text, so that I can debug agent behavior without leaving the inspector
14. As a developer, I want to deep-link from the platform's job page into the inspector, so that the "run and debug" flow is seamless
15. As a developer, I want keyboard shortcuts (Escape to close panel, number keys to jump to agents, brackets to navigate), so that I can work fast

## Implementation Decisions

### Architecture: Thin Client Over Daemon

The inspector is a **thin client** — it does not run pipelines itself. All
execution happens in the daemon. The playground's local pipeline executor
(`pipeline.ts`, `run-fsm.ts`, `direct-executor.ts`) and custom SSE stream
(`execution-context.svelte.ts`) are not used by this page.

**Data source:** The daemon's session event stream
(`SessionStreamEvent` from `@atlas/core/session/session-events`), consumed via
the existing `session-event-stream.ts` async generator and
`reduceSessionEvent()` reducer through the daemon proxy at
`/api/daemon/api/sessions/:id/stream`.

**What the daemon stream provides:**

| Need | Source event | Field |
|------|-------------|-------|
| Waterfall start | `step:start` | `timestamp`, `agentName`, `stepNumber` |
| Waterfall end | `step:complete` | `timestamp`, `durationMs`, `status` |
| Input tab | `step:start` | `input` (prepare function results) |
| Output tab | `step:complete` | `output`, `toolCalls` |
| Trace — tool calls | `step:complete` | `toolCalls[]` (name, args, result, duration) |
| Trace — live text | `EphemeralChunk` | `chunk` (AtlasUIMessageChunk per step) |
| Session lifecycle | `session:start/complete` | status, duration, error |

**What the reduced `SessionView` / `AgentBlock` provides:**
Each `AgentBlock` has `agentName`, `stateId`, `actionType`, `task`, `input`,
`status`, `durationMs`, `toolCalls[]`, `reasoning`, `output`, `error`, and
`ephemeral[]` (live chunks). This maps directly to the waterfall rows and
inspection panel tabs.

**Known gap:** LLM metadata (model name, token counts) is not on
`StepCompleteEvent`. The Overview tab ships without model/tokens; these can be
added to the daemon's event schema in a follow-up.

### Page Layout (5 vertical zones)

**Zone 1 — Selector bar (~48px)**
Workspace dropdown + job dropdown. Populated from daemon API
(`workspace.index` for workspace list, workspace config for job list). Selection
reflected in URL search params (`?workspace=X&job=Y`). Changing either resets
execution state.

**Zone 2 — Pipeline DAG (flex, reduced on execution)**
Existing `PipelineCanvas` component. When execution is idle, it gets normal
height. When running or viewing results, reduced max-height via CSS. No
animation — just a height constraint.

**Zone 3 — Run controls (~60px)**
Signal payload form (inline fields from signal JSON schema, same pattern as
`PipelineInputStrip`) + Run button. No mock/real toggle — always real. If the
job has multiple triggers, a signal selector dropdown appears. Stop button
replaces Run while executing.

**Zone 4 — Waterfall timeline (flex, grows to fill)**
Chrome DevTools network panel style. Shared horizontal time axis. Each agent
is a row: agent name label on the left, horizontal bar showing start→end
relative to session start. Bar color indicates status (running=animated,
succeeded=green, failed=red). Rows appear as `step:start` events arrive. Bar
width updates on `step:complete`.

**Zone 5 — Agent inspection panel (resizable, bottom)**
Opens when a waterfall row is clicked. Tabbed interface:

- **Overview**: agent name, stateId, actionType, status badge, duration.
  The waterfall row data in a readable horizontal layout.
- **Input**: JSON tree of `AgentBlock.input` (the data the agent received from
  the prepare function). Reuse existing JSON tree component.
- **Output**: JSON tree of `AgentBlock.output`. Reuse existing JSON tree
  component.
- **Trace**: Tool calls list (`AgentBlock.toolCalls` — each with name, args,
  result, duration) + live ephemeral chunks (`AgentBlock.ephemeral`). Tool
  calls rendered using existing `tool-call-data.svelte` component from
  session views.

Panel height is resizable via drag handle (same pattern as current
`step-drawer`). Escape closes it.

### Execution Flow

1. User selects workspace + job in selector bar
2. DAG renders from workspace config, signal schema populates the input form
3. User fills payload form, clicks Run
4. `POST /api/daemon/api/workspaces/:workspaceId/signals/:signalId` with payload
5. Response includes session ID
6. Subscribe to `/api/daemon/api/sessions/:sessionId/stream` (SSE)
7. Events reduced via `reduceSessionEvent()` → `SessionView` with `AgentBlock[]`
8. `step:start` → new waterfall row appears (running state)
9. `EphemeralChunk` → live text streams into Trace tab if agent is selected
10. `step:complete` → waterfall bar completes, Output/Trace tabs populate
11. `session:complete` → execution done, all data final

### Module Boundaries

**Selector bar**: hides daemon API queries and URL sync. Exposes
`workspaceId`, `jobId`, and the resolved `WorkspaceConfig`. Consumers don't
know about fetch mechanics or URL parsing.

**Waterfall timeline**: hides timeline math (relative positioning, scaling,
bar width calculation). Takes `AgentBlock[]` and session timestamps. Renders
bars. Doesn't know about SSE or daemon API.

**Agent inspection panel**: hides tab state and layout. Takes the selected
`AgentBlock` and delegates to tab content. Doesn't fetch data itself.

### What Gets Cut

- `GenerationBar` — no generation, no prompt input, no Load YAML
- `PlanningFeed` — no workspace generation flow
- Mock/Real toggle — real execution only
- `StepDrawer` 3-pane layout — replaced by tabbed panel
- `StepDrawerInput` re-run capability — observation only in v1
- Step re-run API calls (`handleStepRerun`, `handleShiftEnterRerun`)
- Playground's local pipeline executor is not used by this page
- `execution-context.svelte.ts` is not used by this page

### What Gets Reused

- `PipelineCanvas` — as-is, just with reduced height CSS
- `session-event-stream.ts` — async generator for daemon SSE consumption
- `reduceSessionEvent()` — builds `SessionView` from event stream
- `tool-call-data.svelte` — tool call request/response display for Trace tab
- JSON tree component — for Input and Output tabs
- Daemon proxy (`/api/daemon/[...path]`) — already exists
- Workspace/job queries from platform pages — for selector bar

## Testing Decisions

Good tests for this feature verify external behavior: given a workspace config
and execution data, do the right things render? Don't test internal state
management or CSS.

- **Waterfall timeline**: given `AgentBlock[]` with known timestamps, durations,
  and statuses, verify correct bar positioning and status rendering. Prior art:
  `collapsible-state.test.ts`, `schema-utils.test.ts` (unit tests for derived
  display logic).
- **Selector bar URL sync**: given URL params, verify correct workspace/job
  selection. Given selection changes, verify URL updates. Prior art:
  `prompt-history.test.ts`.
- **Tab content delegation**: given an `AgentBlock`, verify correct props
  passed to reused components per tab. Lightweight — the components themselves
  are already tested.

## Out of Scope

- Step re-run / "Run with Edits" — observation only in v1
- Mock execution mode
- Workspace generation / YAML loading
- LLM metadata (model name, token counts) in Overview tab — requires daemon
  event schema enrichment
- Assembled prompt view in Trace tab
- Timeline scrubbing / playback of past execution states
- Parallel branch visualization in waterfall (sequential rows for v1)
- Session history / picking past runs (can be added later)
- Contract check validation on Output tab (requires data contract derivation
  from workspace config — can be added later)
