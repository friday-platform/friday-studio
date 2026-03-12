## Problem Statement

The session detail page (`sessions/[sessionId]/+page.svelte`) uses a flat single-column layout with custom CSS. It lacks the sidebar layout used elsewhere in the app, doesn't show connected accounts, doesn't provide a "Run again" action, and agent blocks are missing input display, tabbed tool call views, and per-agent icons from integrations.

## Solution

Restructure the session detail page to use the shared `Page.Root`/`Content`/`Sidebar` layout. Wire up job details and workspace integrations reactively to provide per-agent icons and an accounts sidebar section. Enhance `AgentBlockCard` with input display, Request/Response tabs for tool calls, readable agent output, and a "See output" expandable. No CSS changes — HTML structure and data wiring only.

## User Stories

1. As a user viewing a session, I want to see a sidebar with job info, progress, and accounts so I can quickly understand the session context without scrolling
2. As a user viewing a session, I want to see which integration account each agent used so I can verify the right credentials were applied
3. As a user viewing a session, I want per-agent icons (integration logos for bundled agents, Claude icon for LLM agents) so I can visually identify agent types at a glance
4. As a user viewing a session, I want to see the input data passed to each agent step so I can understand what data flowed between steps
5. As a user viewing a session, I want to toggle between Request and Response tabs on tool calls so I can inspect what was sent vs received
6. As a user viewing a session, I want a readable agent completion summary (not just raw JSON) so I can quickly understand what the agent did
7. As a user viewing a session, I want a "See output" expandable link for full structured output so the page stays clean but I can drill in when needed
8. As a user viewing a session, I want a "Run again" button so I can re-trigger the job without navigating to the job config page
9. As a user viewing a session, I want the page header to show the AI summary title and description so I get the gist immediately
10. As a user viewing a session, I want a progress checklist in the sidebar showing each agent step with its status so I can see at a glance what completed
11. As a user viewing a session, I want a session completed footer with final status and total duration so I know the outcome

## Implementation Decisions

### Layout restructure

- Replace the custom `<div class="page"><div class="content">` wrapper with `Page.Root` > `Page.Content` + `Page.Sidebar`
- Remove `Breadcrumbs` component entirely
- Use `Page.Content`'s `header` snippet for `<h1>{displayTitle}</h1>`
- Use `Page.Content`'s `description` snippet for `<p>{session.aiSummary.summary}</p>`
- Delete the custom `.page` and `.content` CSS rules; keep all inner element styles (status badges, agent blocks, summary, errors, etc.)

### Reactive data loading

Both queries depend on `session.workspaceId` and `session.jobName` which arrive via the SSE stream, so they must be loaded reactively (not in `+page.ts`).

**Job details query:**
- `createQuery` keyed on `["job-details", session.workspaceId, session.jobName]`
- Calls `client.jobs[":jobId"][":workspaceId"].$get({ param: { jobId: session.jobName, workspaceId: session.workspaceId } })`
- Enabled only when `session?.workspaceId` and `session?.jobName` are truthy
- Returns `{ agents, integrations }` — agents are `FSMAgentResponse[]` with `stateId`, `type`, `agentId`, `tools[]`

**Integrations query:**
- `createQuery` keyed on `["workspace-integrations", session.workspaceId]`
- Calls `loadWorkspaceIntegrations(session.workspaceId)`
- Enabled only when `session?.workspaceId` is truthy
- Returns `Integration[]` with provider details and credentials

### Agent-to-icon mapping

Build a derived lookup from the job details query:

1. For each `AgentBlock`, match `block.agentName` to `FSMAgentResponse.stateId` (the agent `id` format is `{jobName}:{stateId}`, so match on `stateId` portion)
2. Resolve icon:
   - `block.actionType === "llm"` → `getServiceIcon("anthropic")` (Anthropic/Claude icon)
   - `block.actionType === "agent"` → `getServiceIcon(matchedAgent.agentId)` (e.g. `"slack"` → Slack icon, `"linear"` → Linear icon)
3. Pass the resolved icon to `AgentBlockCard` as an optional prop

### AgentBlockCard changes

**New `icon` prop:**
- Optional prop: `icon?: { type: "component"; src: Component } | { type: "image"; src: string }`
- When provided, render it in the status icon position instead of the generic check/close/progress icons
- Fall back to current status icons when no icon is available

**Input card:**
- New section before tool calls: if `block.input` exists, render `<pre>{JSON.stringify(block.input, null, 2)}</pre>` under an "Input" label
- If `block.input` is null/undefined, render placeholder text: `// signal payload (always show no input sent)`

**Tool call Request/Response tabs:**
- Replace the current side-by-side Args/Result layout with a tab toggle
- State: `let activeTab = $state<'request' | 'response'>('request')`
- Two `<button>` elements ("Request" / "Response") that set `activeTab`
- Conditionally render the args `<pre>` or the result `<pre>` based on `activeTab`
- "Response" tab button disabled when `tc.result` is undefined

**Agent completion text:**
- If `block.output` is an object with a `response` string field, render that string as readable `<p>` text
- For all other output shapes, keep the existing truncated JSON `<pre>`

**"See output" expandable:**
- After the agent completion text, add `<details><summary>See output</summary><pre>{full JSON}</pre></details>`
- Only shown when `block.output` is present

### Sidebar sections

**Job section:**
- `<h3>Job</h3>`
- Render `session.jobName` and `session.task`

**Progress section:**
- `<h3>Progress</h3>`
- `<ul>` iterating `session.agentBlocks`
- Each `<li>`: status icon (check/close/spinner based on `block.status`) + `formatAgentName(block.agentName)`

**Accounts section:**
- `<h3>Accounts</h3>`
- Render from the integrations query data
- Each integration: icon via `getServiceIcon(integration.provider)` + display name (`integration.credential?.displayName ?? integration.credential?.label ?? integration.provider`)
- Same rendering pattern as `agent-details.svelte` (icon component or image + label)

### "Run again" button

- Render a `<button>Run again</button>` below the description/header area
- Wire to a `createMutation` that POSTs to the job trigger endpoint
- Needs `session.workspaceId` and `session.jobName` to construct the request

### Session completed footer

- After the agent blocks list, render: `<p>Session {session.status} · {duration}</p>`
- Only show when session is in a terminal state (completed/failed)

## Modules Modified

| Module | Changes |
|--------|---------|
| `apps/web-client/src/routes/(app)/sessions/[sessionId]/+page.svelte` | Layout restructure, reactive job/integration queries, icon mapping, sidebar, "Run again" button, footer |
| `apps/web-client/src/lib/components/session-history/agent-block-card.svelte` | Icon prop, input card, Request/Response tabs, readable output, "See output" expandable |

## Testing Decisions

- No new test files needed — these are pure UI wiring changes
- Manual QA: load a session detail page and verify layout, sidebar sections, icon display, input cards, tool call tabs, "See output" toggle
- Verify reactive queries only fire when `workspaceId`/`jobName` are available (not on initial load)

## Out of Scope

- CSS/styling changes (no new styles, rely on existing Page component and element styles)
- Resources section in sidebar (needs new data model)
- Markdown rendering for tool call outputs (keep raw `<pre>`)
- "Run again" endpoint verification (wire the button, verify endpoint separately)
