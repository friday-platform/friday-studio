# Agent Playground

Shipped on `eric/agent-browser` branch, March 2026.

Unified developer tool at `tools/agent-playground/` (localhost:5200) for
debugging agents and inspecting workspaces. Merged the standalone agent
playground and workspace simulator into a single SvelteKit app with a shared UI
component library. `tools/workspace-simulator/` was deleted entirely.

## What Changed

### packages/ui/ — Shared Component Library

New workspace package published as `@atlas/ui` with two exports:

- **`.`** — Svelte 5 components: `Button`, `Collapsible` (Root/Trigger/Content),
  `SegmentedControl` (Root/Item), `Tooltip`, `Icons` (24px), `IconSmall` (16px)
- **`./tokens.css`** — Design tokens covering spacing, radius, typography,
  z-index, shadows, and semantic colors with dark mode support

Components extracted from the web-client. `@melt-ui/svelte` powers Collapsible
and Tooltip headless behavior. Icons scoped to what's actually used — not the
full web-client set. Token set is the intersection of web-client and playground
values; app-specific tokens (P3, `@property` animations, extended color scales)
stay in each app's CSS.

### Navigation & Routes

SvelteKit route-based navigation with persistent sidebar. Root redirects to
`/agents/bundled`.

```
Sidebar:
  Agents
    Friday           → /agents/bundled
    Custom           → /agents/custom

  Workspaces
    Inspector        → /workspaces
    History          → /workspaces/history
```

Layout: CSS grid with fixed-width sidebar + `1fr` main content. `@atlas/ui`
components throughout.

### Agent Pages

- **Bundled** (`/agents/bundled`) — agent selector, metadata, env editor, prompt
  input, streaming output with token stats, trace panel
- **Custom** (`/agents/custom`) — provider/model picker, system prompt, MCP
  server selector, tool preview, streaming output, trace panel

### Workspace Inspector (`/workspaces`)

Two entry points converging on the same visualization:

1. **Load** — file drop or paste a workspace.yml
2. **Generate** — prompt triggers builder pipeline (prompt → blueprint → FSM →
   workspace.yml) with SSE streaming

Page follows the pipeline flow top to bottom:

1. **Top bar** — workspace name, description, Load/Generate/Clear controls
2. **Signals** — horizontal chip rail with type badges
3. **Agents** — card grid with MCP tool pills per agent
4. **FSM diagram** — hero section, beautiful-mermaid with ELK layout, entry
   action subgraphs, dot-grid canvas
5. **State detail cards** — grid below diagram, color-coded by type
6. **Contracts & mappings** — compact reference cards, collapsible

When generating from prompt, sections build progressively as SSE artifacts
arrive — top bar fills, signals appear, agent cards render, FSM diagram draws,
state cards populate, contracts fill in.

### FSM Diagram

Uses `beautiful-mermaid` (`^1.1.3`) for synchronous SVG rendering with ELK
layout. `flowchart TD` with entry actions as dashed subgraphs per state. Action
nodes styled by type: amber (code), blue (LLM), green (agent), gray dashed
(emit). Dot-grid canvas background, zoom controls.

Three execution phases on the same diagram: static before execution, pulsing
active state during, stepper-controlled highlighting after.

### Execution Drawer

Slides in from right via CSS grid column transition (content reflows, not
overlay). Three zones:

- **Top (pinned)** — stepper controls + results bar showing progressive fill of
  result keys across execution
- **Middle (scrollable)** — entry actions with status/type markers, results
  snapshot with NEW badges, JSON syntax highlighting
- **Bottom (pinned)** — summary: success/failure, final state, duration

### Server Architecture

All backend in the Hono router:

```
src/lib/server/
├── routes/
│   ├── agents.ts            # GET /api/agents
│   ├── execute.ts           # POST /api/execute (bundled)
│   ├── custom.ts            # POST /api/custom/execute
│   ├── mcp.ts               # GET/POST /api/mcp/*
│   └── workspace.ts         # Parse, execute (SSE), runs, re-execute
└── lib/workspace/
    ├── pipeline.ts          # Four-phase pipeline
    ├── run-fsm.ts           # FSM execution harness
    ├── mock-executor.ts     # Mock executor for dry runs
    └── direct-executor.ts   # Real agent execution with MCP
```

Run artifacts split under `runs/`: `agents/<timestamp>-<slug>/` and
`workspaces/<timestamp>-<slug>/`. Both CLI and UI write to the same directory.

## Key Decisions

**Kill workspace-simulator, don't wrap it.** Deleted the monolithic
`playground.html` + raw Deno HTTP server. Useful code extracted into pure
functions in the playground's server directory.

**beautiful-mermaid over stock Mermaid.js.** Synchronous rendering eliminates
flash and race conditions. ELK layout for clean edge routing. CSS variable
theming switches without re-render. Pure string output works in `$derived` —
no DOM dependencies.

**Entry actions inside the diagram.** Dashed subgraphs per-state show what each
state does spatially, instead of a separate list below.

**Grid reflow drawer, not overlay.** Content column shrinks to accommodate the
400px drawer. Nothing gets covered.

**Namespace exports for @atlas/ui.** Compound component pattern
(`Collapsible.Root`, etc.). Consumers opt into tokens via
`import '@atlas/ui/tokens.css'`.

**Intersection token set.** Only tokens shared between web-client and
playground. App-specific tokens stay local.

## Known Gaps

A QA pass (`docs/qa/plans/workspace-inspector-gaps.md`) identified missing
detail in the inspector:

- **Missing fields**: agent prompts, signal payload schemas, FSM
  functions/guards, contract schema types/descriptions, workspace timeout, job
  descriptions
- **Truncation**: contract doc IDs and DAG labels clipped by CSS overflow
- **Structural**: no data flow visualization connecting contracts to states,
  execution panel inaccessible for loaded (non-generated) workspaces

Tracked for follow-up, not blockers.

## Out of Scope

- Web-client migration to `@atlas/ui` (still imports from its own `src/lib/`)
- Complex shared components (Dialog, DropdownMenu, Table, Notification)
- Component docs site / Storybook / visual regression testing
- Deploying the playground (local dev tool, dev mode only)
- Agent run persistence / history for agent executions
- Workspace.yml editing (inspector is read-only)
- Multi-job workspace visualization (single-job FSM focus)
- Mobile/responsive design (desktop dev tool)

## Test Coverage

Pipeline functions unit tested (prompt → blueprint → FSM → workspace.yml with
mock LLM responses). FSM harness has tests moved from old workspace-simulator.
Mermaid definition builder, result snapshot delta, and state card derivation are
pure-function unit tested. Visual rendering, CSS animations, and
beautiful-mermaid SVG output tested via manual QA. `packages/ui` has a
placeholder smoke test; melt-ui internals not re-tested.
