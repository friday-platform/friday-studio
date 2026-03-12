# Workspace Chat Resource Access

Shipped on `workspace-chat-resource-access`, March 2026.

Workspace chat can now directly read and write document resources without
triggering FSM jobs. External resources (Notion, Google Sheets) route through
`do_task`. The workspace planner no longer generates pure-CRUD jobs for
resource-only operations.

## What Changed

### Resource Tools (`packages/system/agents/workspace-chat/tools/resource-tools.ts`)

Two new tools registered on the workspace-chat agent:

- **resource_read(slug, sql, params?)** — read-only JSONB query against the
  resource's draft CTE. Returns rows as JSON.
- **resource_write(slug, sql, params?)** — mutation via SELECT. Agent writes a
  SELECT that computes the new data value; Ledger applies it to the draft.

Both tools include a type guard that checks resource metadata loaded at startup:
- Document resources → forward to Ledger
- External-ref resources → return guidance error redirecting to `do_task`
- Artifact-ref resources → return guidance error suggesting `artifacts_get`
- Unknown slug → forward to Ledger (handles mid-conversation resource creation)

### Agent Wiring (`workspace-chat.agent.ts`)

The handler fetches resource metadata from the daemon API
(`GET /api/workspaces/:workspaceId/resources`) at startup. Uses it to:
- Build the type guard map for resource tools
- Generate resource guidance via `buildResourceGuidance()`
- Conditionally fetch SQL skill text when document resources exist
- Gate resource tool registration on `hasDocuments`

### System Prompt (`prompt.txt`)

Added resource scope, routing rules, and behavioral guidance. Resource guidance
and SQL skill text appended dynamically only when resources exist.

### Tool-Aware Content Filtering

Both `buildResourceGuidance()` and `getSkill()` accept an optional
`availableTools` parameter. Workspace-chat passes
`["resource_read", "resource_write"]` so shared content omits references to
tools the chat agent doesn't have (`resource_save`, `resource_link_ref`).

### Skill Text Server-Side Filtering (`apps/ledger/src/`)

`GET /v1/skill` accepts optional `tools` query parameter. Filters the skill text
template at generation time — conditional includes/excludes in `sqlite-skill.ts`
and `postgres-skill.ts`.

### Orphaned Artifact Fallback (`workspace-chat.agent.ts`)

Keeps existing artifact fetch, merges with daemon resource data, deduplicates.
Orphaned artifacts (no corresponding resource entry) appear as supplementary
guidance with `artifacts_get` routing. Transitional — shrinks to zero as
workspaces adopt the resource system.

### do_task Resource Access (`packages/system/agents/conversation/tools/do-task/`)

Ephemeral executor now receives and passes `resourceAdapter` and
`artifactStorage` to `createEngine()`. Sub-tasks spawned via `do_task` can
read/write workspace resources via FSM resource tools. Benefits both
workspace-chat and conversation agent `do_task` paths.

### Planner Changes (`packages/workspace-builder/planner/plan.ts`)

System prompt instructs the planner not to generate jobs for single-resource CRUD
without external service dependencies. Resource-only workspaces may generate zero
jobs beyond `handle-chat`. Existing workspaces with CRUD jobs are unaffected.

### Runtime (`packages/workspace/src/runtime.ts`)

Reserved signal name validation — "chat" is system-owned, workspaces cannot
define a "chat" signal.

## Key Decisions

**Two purpose-built tools, not reusing SDK tool factories.** The workspace-chat
tools need type guards and structured guidance errors that the generic
`resource-tools.ts` in `agent-sdk` doesn't provide. Similar interface, different
concerns.

**LLM discovers schema via `SELECT * FROM draft LIMIT 1`.** No schema injection
in the system prompt. Always accurate, no infrastructure needed, keeps the prompt
lean.

**No inline publish per write.** Auto-publish at agent turn end and session
teardown is sufficient. The dirty draft is always readable within and across
turns. Avoids version bloat.

**Unknown slugs forward to Ledger instead of hard-erroring.** Handles
mid-conversation resource creation via `do_task` without restarting chat.

**Daemon API for metadata, shared adapter for operations.** Follows existing DI
pattern — workspace-chat receives `resourceAdapter` the same way FSM engine
does. No new configuration needed.

**Keep artifact fetch + merge with dedup.** Older workspaces may have artifacts
without Ledger resource entries. The orphan fallback ensures no data goes
invisible. No migration required.

## Out of Scope

- Higher-level abstraction over SQL (wait for evidence the LLM struggles)
- Read-only mode for chat (both read and write from the start)
- `resource_save` tool for chat (auto-publish handles it)
- `resource_link_ref` tool for chat (external ref registration goes through
  `do_task`)
- Existing workspace migration (CRUD jobs keep working, only new creation
  changes)
- Schema injection in system prompt (LLM discovery is sufficient)

## Test Coverage

- **Resource tool type guard** — document forwards, external_ref returns
  guidance, artifact_ref returns guidance, unknown slug forwards
  (`resource-tools.test.ts`)
- **Resource tool happy path** — read returns results, write applies mutations,
  both tabular and prose documents
- **System prompt assembly** — resource guidance + skill text included when
  documents exist, omitted otherwise, orphaned artifacts shown separately
  (`workspace-chat.agent.test.ts`)
- **Tool-aware filtering** — `buildResourceGuidance()` adapts instructions per
  available tools (`guidance.test.ts`); `getSkill()` filters skill text
  (`skill-text.test.ts`)
- **Skill text endpoint** — `GET /v1/skill?tools=...` returns filtered text
  (`routes.test.ts`)
- **Job tools** — existing coverage updated for new client mock shape
  (`job-tools.test.ts`)
- **Planner output** — resource-only workspaces generate zero CRUD jobs
  (`plan.test.ts`)
