# Workspace Jobs Views

## Problem Statement

Jobs are buried in the workspace sidebar as simple cards with only a "Run Now"
button. Users can't see what integrations a job uses at a glance, can't navigate
to a dedicated job page, and job names like `capture_and_log_friday_learning_ideas`
display raw without formatting.

## Solution

Redesign job cards on the workspace overview page with integration icons, formatted
names, and Run/View buttons. Add a top-level `/jobs/[jobId]/[spaceId]` route for
individual job detail pages. Augment the API to return integration (provider) info
alongside job data.

## User Stories

1. As a workspace user, I want to see which integrations a job uses at a glance,
   so that I understand what services it connects to
2. As a workspace user, I want job names formatted as readable text, so that
   `capture_and_log_friday_learning_ideas` displays as "Capture and log friday
   learning ideas"
3. As a workspace user, I want a "View" button on each job card, so that I can
   navigate to a dedicated job detail page
4. As a workspace user, I want a "Run" button on each job card, so that I can
   trigger the job (existing behavior, preserved)
5. As a workspace user, I want a job detail page showing title, description,
   signals, and agents, so that I can understand the job's configuration
6. As a workspace user, I want job cards in the main content area (not the
   sidebar), so that jobs are more prominent

## Implementation Decisions

### API Changes

**1. Augment `GET /api/workspaces/:workspaceId/jobs`**

Current response: `Array<{ name: string; description?: string }>`

New response:
```typescript
Array<{
  id: string;              // raw job key, used for routing
  name: string;            // pre-formatted display name (title > formatted name > id)
  description?: string;
  integrations: string[];  // provider names from credential requirements
}>
```

Name formatting (server-side): if `job.title` exists, use it. Otherwise take
`job.name`, replace underscores with spaces, sentence case. Fall back to job key.

Integration extraction: use `extractCredentials()` from `@atlas/config` against
the workspace config, then filter to providers referenced by the job's agents'
MCP servers. The `integrations` field contains provider names that map directly
to `getServiceIcon(provider)` in the web client.

**2. New `GET /api/jobs/:jobId/:workspaceId` route**

New file: `apps/atlasd/routes/jobs.ts`

Returns:
```typescript
{
  id: string;
  name: string;            // same formatting as list endpoint
  description?: string;
  integrations: string[];
  triggers: TriggerSpecification[];
  agents: JobExecutionAgent[] | undefined;
}
```

Duplicated intentionally — these endpoints will diverge later.

Typed Hono RPC pattern (same as all other routes):
- Create route with `daemonFactory.createApp().get("/:jobId/:workspaceId", ...)`
- Export `type JobsRoutes = typeof jobsRoutes`
- Add type export to `apps/atlasd/mod.ts`
- Mount in `atlas-daemon.ts` via `this.app.route("/api/jobs", jobsRoutes)`
- Add to client in `packages/client/v2/mod.ts`: `jobs: hc<JobsRoutes>(...)`
- Web client calls `client.jobs[":jobId"][":workspaceId"].$get({ param: { jobId, workspaceId } })`

### Web Client Changes

**3. Redesign job cards on workspace page**

File: `apps/web-client/src/routes/(app)/spaces/[spaceId]/+page.svelte`

- Move job rendering from sidebar into `<article class="content">`, after the
  `{#if workspace.description}` block
- Remove job cards from sidebar
- Each card renders (matching the mockup):
  - Integration icons row (small SVGs, no background — from `getServiceIcon`)
  - Title (see formatting rules below)
  - Description
  - "Run" button (opens existing `RunJobDialog`)
  - "View" button (links to `/jobs/[jobId]/[spaceId]`)

**4. Job name formatting**

Handled server-side in both API endpoints. Web client uses `name` directly.

**5. New route: `/jobs/[jobId]/[spaceId]`**

Files:
- `apps/web-client/src/routes/(app)/jobs/[jobId]/[spaceId]/+page.ts` — loader
  fetches from `GET /api/jobs/:jobId/:workspaceId`
- `apps/web-client/src/routes/(app)/jobs/[jobId]/[spaceId]/+page.svelte` — page

Page displays:
- Name (pre-formatted from API)
- Description
- Signals used: `JSON.stringify(job.triggers)` (raw for now)
- Agents used: `JSON.stringify(job.agents)` (raw for now)

### Data Flow

```
workspace.yml
  └─ tools.mcp.servers[id].env[var] = { from: "link", provider: "slack", ... }
       ↓
extractCredentials(config) → CredentialUsage[] (with provider field)
       ↓
API filters by job's agent → MCP server chain
       ↓
Response includes integrations: ["slack", "linear"]
       ↓
Web client: getServiceIcon("slack") → Svelte component
```

## Testing Decisions

- API tests for the augmented jobs list endpoint — verify integrations are
  extracted correctly from credential refs in MCP server env vars
- API test for the new single-job endpoint — verify it returns the expected
  shape
- Tests should verify the name formatting utility (underscores → spaces,
  sentence case)
- Prior art: existing workspace route tests in `apps/atlasd/routes/workspaces/`

## Out of Scope

- Job creation/editing UI
- Job execution history on the detail page
- Job metrics/analytics
- Non-JSON display of signals and agents on the detail page
- Styling the job detail page beyond basic layout

## Further Notes

- The two API endpoints (list and single) intentionally duplicate code — they'll
  diverge as the job detail page grows richer
- Integration icon detection relies on `provider` field in `LinkCredentialRef`
  objects in MCP server env vars — MCP servers without credential refs won't
  show integration icons
