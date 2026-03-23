# Friday Developer Platform

Shipped March 2026. Consolidates eight planning documents into a single
reference for the playground-to-platform redesign, cockpit UX, agent
indirection, and PR review follow-ups.

The agent playground (`tools/agent-playground`) was redesigned from an internal
debugging tool into the primary product UI for Friday as a local-first developer
platform — "orchestration in a box." The platform connects to the local daemon
(`localhost:8080`), provides a workspace cockpit for understanding and operating
workspaces, and surfaces skills, agents, sessions, and execution state in a
unified three-column layout.

## What Changed

### Workspace Cockpit (`/platform/[workspaceId]`)

The cockpit is the primary workspace view with three zones:

**Center column:**
- **Agents strip** — horizontal cards derived from top-level `agents:` config.
  Each card shows agent name, one-line description, type badge, and credential
  health dot (green/amber/red/none based on `from: "link"` env var resolution).
  In multi-job mode, agents not used by the selected job dim to `opacity: 0.4`.
- **Job selector** — horizontal pills between agents strip and pipeline. Only
  renders when 2+ jobs exist. Each pill shows job name, last-run status dot,
  step count.
- **Pipeline diagram** — vertical flow of FSM steps. Idle and completed terminal
  nodes removed. Step nodes show humanized names (`step_clone_repo` → "Clone
  Repo") with agent reference as secondary label. Edges labeled with `outputType`
  document names between steps.
- **Below-pipeline sections** — three collapsible panels:
  - **Integrations** — credentials grouped by provider (not per-agent), showing
    env var key, agent count, status. MCP servers listed with transport type and
    tool count. Always-expanded by default.
  - **Data Contracts** — producer → consumer step pairs with document type name
    and inline schema preview. Clicking highlights pipeline nodes.
  - **Signals** — signal name, type badge, endpoint path/schedule, input schema
    fields, triggered jobs.

**Right sidebar (idle):**
- Run controls — signal selector, compact payload textarea (~80px), trigger
  button. Triggering starts pipeline live status.
- Recent Runs — last 5 sessions with status dot, job name, relative timestamp,
  duration. Polls every 5s.
- Workspace metadata — name, description, agent/signal/step counts, link to
  open YAML.

**Right sidebar (selected):**
- Agent card clicked → workspace-level editor: name, description, model picker,
  workspace-level prompt (blur-to-save), env vars (read-only), "Used In"
  section listing pipeline steps that reference the agent.
- Step node clicked → job-level editor: step name, agent reference, task prompt
  (blur-to-save), "Produces" section showing output document type and schema.

#### Living Blueprint — Execution Status on Pipeline

When a session is active or completed, pipeline nodes reflect status through
left accent borders (green = success, amber = active, red = failure). CSS
transitions only — no JS animations. A step counter appears at the top:
`✓ 3/3 steps · 4.2s`. Status data comes from the session SSE stream.

#### Filmstrip — Inline Step Expansion

Clicking a step during/after a run expands it in-place to show entry actions
(FN, AGENT, EMIT) with status icons. Clicking an action row deep-links to the
corresponding agent block in the session detail view. When no run data exists,
expansion shows the structural action list without status.

### Sessions View (`/platform/[workspaceId]/sessions`)

**List page:** Compact cards with status, job name, timestamp, duration. Active
sessions pin to top.

**Detail page:** Near-direct port of the web-client session view. Components
copied (not shared): `AgentBlockCard`, `StepBlock`, `FormattedData`,
`JsonHighlight`. Data layer uses `daemonClient` via TanStack Query through the
SvelteKit proxy. Same SSE protocol (`SessionStreamEvent`, `EphemeralChunk`) and
reducer (`reduceSessionEvent` from `@atlas/core/session/session-reducer`).

### Agents Page (`/platform/[workspaceId]/agents`)

Redesigned agent cards with two-tier progressive disclosure:

**Glance tier (collapsed):** Status dot (from preflight), name, type badge,
description, tool pills (MCP server names), "Used In" pills, config strip
(LLM: `provider / model · temp 0.3`).

**Detail tier (expanded):** Accordion sections — Prompt, Configuration (property
table), Tools (MCP servers + transport), Environment (vars with resolution
source and preflight status), Used In (per-job: step name, document type,
output schema). Atlas agents additionally show bundled agent metadata (version,
constraints, expertise) and I/O schemas from registry. No sidebar — inline
expansion only, multiple cards can be open.

### Skills Section (`/platform/[workspaceId]/skills`)

**Server (atlasd):** Two new endpoints on the skills router:
- `GET /api/skills/:namespace/:name/files` — lists archive file paths via
  `tar.list()`
- `GET /api/skills/:namespace/:name/files/*path` — extracts single file content
  via selective `tar.extract()`

**Skills list page:** Derives from `useWorkspaceConfig()` → `config.skills`.
Global refs resolved in parallel via daemon proxy. Card rows show name,
description, type badge (catalog/inline), disabled indicator.

**Skill editor page:** Copy-adapted from web-client. `Page.Root > Page.Content
+ Page.Sidebar` layout. ProseMirror-based `MarkdownEditor` for instructions.
Auto-save (dirty tracking, 3s interval, save on blur/`beforeNavigate`). Routes
by `namespace/name` (no `skillId`). No draft/create flow.

**References sub-tree:** Sidebar tree when skill has an archive. Clicking a
reference file swaps main content to read-only markdown renderer. "Details"
entry returns to editor. State-driven via `activeView: 'editor' | { file:
string }` discriminated union. Editor stays mounted (hidden) to preserve dirty
state.

**Inline skills:** Read-only in this iteration. Click navigates to YAML editor.

### Agent Indirection: Delegate Model

FSM entry actions reference workspace agent keys (`agentId: repo-cloner`)
instead of runtime types (`agentId: claude-code`).

**Two-phase resolution:**
1. **FSM expansion** (at engine init): `expandAgentActions(fsmDefinition,
   workspaceAgents)` walks `type: agent` actions. LLM agents convert to
   `type: llm` with provider/model/tools/combined prompt. Atlas/system agents
   pass through. Pure function in `packages/config/`.
2. **Runtime resolution** (at execution): `resolveRuntimeAgentId(agentConfig,
   agentId)` extracts the runtime ID (`agent` field) from atlas/system agents.
   LLM agents log a warning (expansion should have handled them). Unknown
   agentIds pass through for backward compat. Pure function in
   `packages/config/`.

**Prompt strategy:**
- Bundled agents: placeholder prompt on workspace agent (schema-required, ignored
  at runtime). FSM action carries task-specific prompt.
- LLM agents: role prompt in `config.prompt`, task prompt on FSM action.
  `expandAgentActions` combines them.

**Workspace builder changes:**
- `stamp-execution-types.ts` — `executionRef = step.agentId` (workspace key)
  instead of `agent.bundledId`
- `build-fsm.ts` — unified: all agents produce `agentAction(step.agentId, ...)`
- `build-workspace.ts` — placeholder prompt for bundled agents, LLM prompt stays
  in `config`

**Backward compat:** If `agentId` doesn't match any workspace agent key, both
functions pass through unchanged. Old workspaces with `agentId: claude-code`
continue to work.

### Thread-Aware Follow-up Reviews

**Two new gh agent operations** (`packages/bundled-agents/src/gh/agent.ts`):
- `pr-read-threads` — fetches all review comments via GitHub API, groups into
  threads by `in_reply_to_id`, filters to Friday's threads by matching
  `user.login` against authenticated user
- `pr-post-followup` — posts thread replies, new inline findings, and follow-up
  summary. Refactored: inline comment posting loop and summary posting extracted
  into shared helpers (used by both `pr-inline-review` and `pr-post-followup`)

**New workspace config** (`examples/pr-review/workspace.yml`):
- `continue-review` signal (HTTP, `POST /webhooks/continue-review`)
- `pr-followup-review` job with 4 FSM states: clone → read-threads →
  followup-review (claude-code with thread-aware prompt) → post-followup
- 3 new document types: `threads-result`, `followup-review-result`,
  `post-followup-result`

### Navigation & Layout

Root `+layout.svelte` provides two-column shell (220px left nav + fluid
content). Platform routes add right contextual sidebar (280-320px). Existing
tool pages (Agent Tester, Inspector) remain under "Tools" section.

**Route structure:**
```
platform/
├── +layout.svelte         # Right sidebar, QueryClientProvider
├── +page.svelte           # Cockpit
├── [workspaceId]/
│   ├── agents/            # Agents page
│   ├── skills/            # Skills list + editor
│   ├── jobs/              # Jobs
│   └── sessions/          # Session list + detail
```

**Daemon proxy:** `routes/api/daemon/[...path]/+server.ts` forwards to
`http://localhost:8080/api/*`. SSE streams proxied with passthrough bodies.

**Daemon connectivity:** TanStack Query polling `GET /api/health` every 5s.
Status dot in left sidebar (green/red). Disconnected state shows centered
message with start command. Recovery triggers automatic refetch.

### Data Fetching

TanStack Query (`@tanstack/svelte-query`) scoped to platform routes only.
`QueryClientProvider` wraps `platform/+layout.svelte`. Existing playground pages
keep direct Hono client pattern.

**`daemonClient`** typed against daemon's Hono router. Queries use it for all
daemon communication through the SvelteKit proxy.

**Editing:** Blur-to-save on textareas, change-to-save on dropdowns. Toast on
success. Optimistic rollback via `useMutation` (`onMutate` snapshot, `onError`
rollback, `onSettled` refetch).

### Data Derivation Functions (packages/config/)

All pure functions on `WorkspaceConfig`:
- `deriveTopology(config)` — workspace config → `{ nodes, edges }` for pipeline
- `deriveWorkspaceAgents(config)` — enriched agent data with model/provider/
  temperature/tools
- `deriveAgentJobUsage(config)` — agent → job/step cross-references
- `deriveAllEntryActions(config)` — FSM state entry action lists
- `deriveIntegrations(config)` — credentials grouped by provider with agent
  counts
- `deriveDataContracts(config)` — producer/consumer pairs with document types
  and schemas
- `deriveSignalDetails(config)` — signal metadata with schemas and job mappings
- `expandAgentActions(fsmDef, agents)` — LLM agent expansion at load time
- `resolveRuntimeAgentId(agentConfig, agentId)` — runtime ID extraction

## Key Decisions

**Cockpit is triage, session detail is debug.** The cockpit shows execution
state on the pipeline structure (which steps ran/failed). The session detail
shows full execution content in a scrolling timeline (what the agent produced,
why it failed). Cockpit → filmstrip → deep-link to session detail.

**Delegate model, not extend or override.** Workspace agents are named
references to runtime agents. Bundled agents are self-contained — making
workspace agents override their config adds complexity without value. The
runtime's `resolveRuntimeAgentId` fallback makes it safe to add extend
semantics later.

**Expand at load time, not unify action types.** The FSM engine has different
execution paths for `type: agent` and `type: llm`. Unifying would mean moving
LLM execution into the workspace runtime. Expanding before engine init keeps
the engine unchanged while giving authors a uniform format.

**Copy session components, don't share.** `AgentBlockCard`, `StepBlock`, etc.
are copied into the playground, not shared via `@packages/ui`. They may diverge
between local and cloud. Only genuinely identical components (`FormattedData`,
`JsonHighlight`) go in `@packages/ui`.

**Credentials grouped by provider, not per-agent.** The developer action is
"connect my GitHub OAuth," not "configure repo-cloner's env." Provider-centric
grouping maps to the action. Per-agent view exists in the agent sidebar.

**Collapsible sections, not tabs.** Tabs hide information behind clicks. The
goal is "scroll top-to-bottom and grok the workspace in 30 seconds."

**Separate job for follow-up reviews.** Initial review and follow-up are
separate jobs with separate signals. Keeps FSMs linear. GitHub is source of
truth — no persistent review state in Friday.

**Skills route by namespace/name, not skillId.** Workspace skills are referenced
by `@namespace/name`. No draft handling — always shows/edits latest version.

## Error Handling

**Daemon disconnected:** Global health check drives all connectivity UI.
Individual queries don't show their own disconnected errors. Centered state
with start command and retry button. Nav still renders.

**Editing failures:** Optimistic rollback — snapshot before mutation, restore on
error. Toast notifications for both success and failure.

**Backward compat failures:** `resolveRuntimeAgentId` logs a warning when an
LLM agent reaches the agent executor (expansion should have caught it). Returns
agentId as-is rather than blocking execution.

**Follow-up review edge cases:** Running follow-up on a PR with no prior review
handles gracefully (0 threads, just reviews new changes). Thread replies that
fail (outdated threads) are silently skipped.

## Out of Scope

- Signal schedule editing (cron picker, timezone) — read-only for v1
- Agent tool/CLI/temperature editing in cockpit sidebar — prompt + model only
- Full interactive SVG graph diagram — v1 uses vertical pipeline view
- Execution-mode job support — FSM-based only
- Live credential status checking — v1 shows declared credentials from config
- Editable credentials from cockpit — requires secret management API
- MCP tool-level detail — server names only, not individual tools
- Schema diffing/compatibility checking between producers and consumers
- Ghost run / predictive execution preview
- Session diffing (comparing two runs side-by-side)
- Rewind & Fork (branching execution from a completed step)
- Agent color threading (visual linkage between cards and pipeline steps)
- Inline skill editing — read-only, edit via YAML
- Reference file editing in skill editor — architecture supports it for later
- Skill creation/deletion from playground
- Version history for skills
- Mobile / responsive — desktop-only
- Multi-user / auth — local single-user tool
- Making `AtlasAgentConfigSchema.prompt` optional (bundled agents use
  placeholder)
- Env var cleanup on bundled agents (still declare for UI display)

## Test Coverage

**Pure function unit tests** (primary strategy): `deriveTopology`,
`deriveIntegrations`, `deriveDataContracts`, `deriveSignalDetails`,
`deriveAgentJobUsage`, `expandAgentActions`, `resolveRuntimeAgentId`, step name
humanization, agent strip data derivation, filmstrip action derivation, sidebar
state transitions, Living Blueprint status mapping. Tested with
`examples/pr-review/workspace.yml` as primary fixture plus synthetic multi-job
configs.

**Integration tests** for `expandAgentActions` and `resolveRuntimeAgentId`
against real workspace configs (pr-review and notion-research) — both legacy
backward-compat and rewritten delegate-model configs.

**Updated builder tests:** `stamp-execution-types.test.ts` (executionRef =
workspace agent key), `build-fsm.test.ts` (all agents produce `agentAction`).

**Server tests for skills:** Archive file listing, individual file fetch, no
archive handling, file not found (404). Prior art:
`apps/atlasd/routes/skills.test.ts`.

**Not tested (manual QA):** CSS transitions, visual layout, pipeline rendering,
credential dot colors, edge label positioning, multi-job dimming.
