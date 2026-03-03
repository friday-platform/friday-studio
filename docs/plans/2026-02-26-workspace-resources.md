# Workspace Resources

Shipped on branch `workspace-storage`. Workspace-scoped persistent state that
agents can discover, query, and mutate across sessions. Originally shipped as
per-resource SQLite tables (Feb 19), then redesigned to a two-table JSONB model
behind a standalone Ledger microservice (Feb 25-26).

Resources give workspaces durable, structured data. Three resource types —
document (tabular or prose), artifact-ref (large/binary files backed by
artifacts), and external-ref (pointers to Google Sheets, Notion, etc.) — stored
in the same two tables, discriminated by `type` on metadata. Agents interact via
JSONB queries taught by per-adapter skills. Users manage resources through the
workspace detail page and file uploads.

## What Changed

### Ledger Service (`apps/ledger`)

Standalone multi-tenant microservice owning the resource data layer. Same
architectural pattern as Link. Deno + TypeScript, Hono, Zod v4.

**Two-table JSONB storage model:**

- **`resource_metadata`** — catalog of all resources, one row per resource.
  Keyed by `(workspace_id, slug)`. Tracks `type`, `current_version`.
  Deletes are hard (`DELETE` with `CASCADE` to versions).
- **`resource_versions`** — version history + mutable draft. Each resource has
  one draft row (`version IS NULL`) and zero or more immutable version rows
  (`version >= 1`). Draft carries `schema` (JSON Schema), `data` (JSONB), and a
  `dirty` flag. Partial unique index enforces one draft per resource.

**Draft/publish versioning:** Agents read and write against the draft row.
`publish()` snapshots the draft as a new immutable version. `provision()`
auto-publishes version 1 so `resetDraft()` always has a baseline. The platform
auto-publishes dirty drafts at agent turn end, FSM step completion, and session
teardown. `resource_save` exists for mid-loop checkpoints.

**Optimistic concurrency:** `mutate()` uses a `draft_version` stamp with
conditional UPDATE (3 retries on conflict). Agent's SELECT runs on a read-only
connection to compute the new data value; the adapter applies the UPDATE on a
writable connection internally.

**Adapter interface** (`types.ts`): `init`, `destroy`, `provision`, `query`,
`mutate`, `publish`, `replaceVersion`, `listResources`, `getResource`,
`deleteResource`, `linkRef`, `resetDraft`, `getSkill`.

**Two adapters:**

- **SQLiteAdapter** — local dev. Single `.db` file, WAL mode, 5s busy timeout.
  Separate read-only connection for agent SQL. Triggers for `updated_at`.
- **PostgresAdapter** — production. Uses `withUserContext()` for RLS-scoped
  transactions. `SET TRANSACTION READ ONLY` for agent SQL. Immutability triggers
  reject UPDATE/DELETE on versioned rows. RLS policies on both tables filter by
  `user_id`.

**HTTP routes** (all under `/v1/resources`):

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/:workspaceId` | List resources |
| GET | `/:workspaceId/:slug` | Get resource (draft or published) |
| POST | `/:workspaceId/provision` | Upsert resource |
| POST | `/:workspaceId/:slug/query` | Read-only query passthrough |
| POST | `/:workspaceId/:slug/mutate` | Mutation passthrough |
| POST | `/:workspaceId/:slug/publish` | Snapshot draft as version |
| POST | `/:workspaceId/:slug/reset-draft` | Reset draft to latest version |
| POST | `/:workspaceId/:slug/link-ref` | Update ref on external_ref |
| PUT | `/:workspaceId/:slug/version` | Replace version (file upload) |
| DELETE | `/:workspaceId/:slug` | Soft delete |
| GET | `/v1/skill` | Dialect-specific agent skill text |

**Middleware chain:** access log, trim trailing slash, JWT verification (prod),
tenancy extraction (JWT → userId), adapter injection via factory.

**Config:** `DEV_MODE`, `LEDGER_PORT` (default 3200),
`LEDGER_SQLITE_PATH`, `LEDGER_POSTGRES_CONNECTION`. Adapter selected at startup
based on whether Postgres connection is configured.

### Per-Adapter Skills (`sqlite-skill.ts`, `postgres-skill.ts`)

Agent-facing SQL teaching documents served at `GET /v1/skill`. Each skill
teaches the `draft` CTE scope (agent SQL references `draft.data` and
`draft.schema`), dialect-specific JSONB functions, and common query/mutation
patterns.

**SQLite:** `json_each()`, `json_extract()`, `json_group_array()`, `json_set()`,
`json_insert()`. Documents the `json()` wrapper gotcha for booleans/nested JSON.

**Postgres:** `jsonb_array_elements()`, `->` / `->>`, `jsonb_agg()`,
`jsonb_build_object()`, `jsonb_set()`. Documents casting patterns and parameter
offset (`$2, $3...` — `$1` reserved internally).

### Resource Utilities (`packages/resources`)

Client-side utilities consumed by the daemon and agent runtime.

- **`ledger-client.ts`** — HTTP client implementing `ResourceStorageAdapter`
  via Hono RPC. The daemon's sole interface to Ledger.
- **`enrich.ts`** — `toCatalogEntries()` maps Ledger metadata to
  `ResourceCatalogEntry[]`. `enrichCatalogEntries()` resolves artifact metadata
  (type, row count) for artifact-ref entries.
- **`guidance.ts`** — `buildResourceGuidance()` formats runtime resource list
  into categorized markdown for agent prompts (Documents, Datasets, Files,
  External). `buildDeclarationGuidance()` does the same for planner context.
- **`publish-hook.ts`** — `publishDirtyDrafts()` auto-publishes all dirty
  drafts for a workspace. Safe to call unconditionally.
- **`types.ts`** — `ResourceCatalogEntry` (thin, pre-enrichment) and
  `ResourceEntry` (enriched with artifact metadata).

### Agent Tools (`packages/agent-sdk/src/resource-tools.ts`)

Four tool factories:

- **`resource_read(slug, query, params?)`** — read-only JSONB query against
  draft via `adapter.query()`.
- **`resource_write(slug, query, params?)`** — mutation via SELECT. Agent writes
  a SELECT returning the new data value; adapter applies it to draft.
- **`resource_save(slug)`** — publishes draft as immutable version via
  `adapter.publish()`. No-op if draft is clean.
- **`resource_link_ref(slug, ref)`** — updates ref on external_ref resources
  via `adapter.linkRef()`.

### Daemon Integration (`apps/atlasd`)

**Ledger proxy** (`routes/ledger.ts`): Proxies `/api/ledger/*` to Ledger at
`localhost:3200/v1/*`. Forwards `X-Forwarded-*` headers and `ATLAS_KEY` auth.

**Resource management routes** (`routes/workspaces/resources.ts`): Higher-level
endpoints that add upload classification, CSV export, and enrichment on top of
Ledger:

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/:workspaceId/resources` | List (enriched with artifact metadata) |
| GET | `/:workspaceId/resources/:slug` | Detail (columns/rows or prose content) |
| GET | `/:workspaceId/resources/:slug/export` | CSV download |
| POST | `/:workspaceId/resources/upload` | File upload with auto-classification |
| PUT | `/:workspaceId/resources/:slug` | Replace resource data |
| DELETE | `/:workspaceId/resources/:slug` | Soft delete + artifact cleanup |

**Upload storage strategy** (decided at upload time by file type and size):

| Input | Size | Result |
|-------|------|--------|
| CSV | < 5 MB | Document (tabular). Parsed to JSONB array. Mutable. |
| CSV | >= 5 MB | Artifact ref. Read-only. |
| Markdown, TXT | < 5 MB | Document (prose). String. Mutable. |
| DOCX | < 5 MB | Document (prose). Converted to markdown. Mutable. |
| Any file | >= 5 MB | Artifact ref. Read-only. |
| Binary (PDF, image) | Any | Artifact ref. Read-only. |

Strategy is locked at first upload — Replace preserves the original type.

### Prompt Injection (4 Sites)

1. **FSM engine** — `buildContextPrompt()` runs enrichment pipeline →
   `buildResourceGuidance()` before every LLM action.
2. **Agent helpers** — `buildAgentPrompt()` same pipeline for non-FSM agents.
3. **Planner pipeline** — `buildDeclarationGuidance()` at plan time.
4. **Conversation agent** — workspace-creation skill includes resource context
   in requirements-gathering (storage questions, "Friday first" directive).

### Auto-Publish Lifecycle

Dirty drafts are published at three levels:

1. **FSM step completion** — after each agent action resolves.
2. **Agent turn end** — when the tool loop finishes.
3. **Session teardown** — defensive catch-all.

`publishDirtyDrafts()` queries for `dirty = TRUE` draft rows and publishes
each. No JSONB comparison needed.

### Draft Recovery

On session start, `resetDraft()` restores draft to latest published version and
clears dirty flag. Since `provision()` auto-publishes version 1, a published
version always exists.

### Web Client

- **ResourcesSection** — workspace detail page. Lists resources with
  type-specific rendering, manages upload/replace/delete.
- **ResourceRow** — dispatches on type: table → view/replace, artifact_ref →
  view/replace with read-only badge, external_ref → open link.
- **Resource detail page** — document resources only. Schema + data rows,
  row count, CSV download.
- **Plan card preview** — displays proposed resource schemas before workspace
  approval.

## Key Decisions

**Documents, not tables.** The original design created a SQLite table per
resource, requiring DDL generation, PRAGMA introspection, and staging-table
swaps. The redesign stores everything as JSONB in two tables. Agents query via
JSONB functions taught by per-adapter skills instead of raw SQL against discrete
tables.

**Standalone Ledger service.** Resource storage lives in its own microservice,
not inside the daemon. The daemon talks to Ledger over HTTP via a client SDK.
This separates multi-tenant data concerns from single-tenant daemon logic and
mirrors the Link pattern. Adapter choice (SQLite vs Postgres) is Ledger's
internal concern.

**Draft/publish over direct mutation.** Each resource has exactly one mutable
draft row. An explicit publish snapshots it as an immutable version. This
separates agent working state from version history and enables crash recovery
(reset draft to latest published version).

**Read-only database connection for agent SQL.** Safety boundary is
database-enforced, not string-parsed. SQLite uses `?mode=ro`, Postgres uses
`SET TRANSACTION READ ONLY`. DML in agent SQL is rejected by the database
engine.

**CTE scope injection.** The adapter wraps agent SQL in a `WITH draft AS (...)`
CTE that resolves the slug within the workspace. Agents reference `draft.data`
and `draft.schema` without knowing UUIDs, table structure, or version
semantics.

**Per-adapter skills over portable SQL.** JSONB dialects diverge significantly
(json_each vs jsonb_array_elements, json_extract vs ->>). Skills teach
dialect-specific patterns; the adapter interface stays dialect-agnostic.

**Optimistic concurrency on draft mutations.** `draft_version` stamp with
conditional UPDATE and 3 retries. Avoids pessimistic locking overhead for a
single-writer workload.

**Schema per version.** `schema` lives on version rows, not metadata. Each
version carries its own schema, enabling structure evolution without breaking
history.

**File size threshold (5 MB) over row count.** Simpler to check, applies
uniformly across file types. Large CSVs become artifact-refs analyzed via
DuckDB.

**Clean break migration.** No migration of existing per-resource SQLite data.
Resources are declarative (re-provisioned from workspace config on next access).
Acceptable because the system is pre-production.

## Error Handling

**Agent SQL errors** include schema context (available fields, example syntax)
for self-correction. Read-only violation errors are rewritten to agent-friendly
messages.

**Artifact-ref queries** via resource_read return metadata-rich errors with the
artifact ID and guidance. Prompt injection already tells agents how to access
each resource type.

**Upload failures:** 409 on slug collision (client retries with suffix), 422 on
type mismatch. Import failures roll back — original data preserved.

**Missing artifacts:** Artifact-ref resources whose backing artifact was deleted
show `artifactType: "unavailable"`. UI shows warning badge. Omitted from agent
prompt guidance.

**Concurrency conflicts:** Optimistic retry (3 attempts) on draft_version
mismatch in mutate. Surfaces error after exhaustion.

## Out of Scope

- **Schema validation on write** — schema is descriptive, not enforced
- **Cross-resource queries** — no JOINs across resources
- **Partial document updates for prose** — whole-document replace only
- **Real-time collaboration** — single-writer model
- **Version pruning / compaction** — append-only forever for now
- **Column-projecting views** — virtual columns from JSONB array elements
- **SQL helper functions** — registered `resource_append()` etc. wrappers
- **Inline editing UI** — no click-to-edit cells or markdown editor
- **Streaming large JSONB** — full blob loaded on every read
- **DuckDB for document queries** — JSONB queries use native SQLite/Postgres
- **Schema evolution tooling** — schema changes between versions are implicit
- **Resource rename** — slugs are immutable stable identifiers
- **Drag-and-drop upload** — button-triggered file picker only

## Test Coverage

**Ledger adapters** (`apps/ledger/src/`): ~2,000 lines across SQLite and
Postgres adapter tests. Every adapter method has a dedicated describe block.
Covers provision idempotency, draft/publish cycles, replace cycles, dirty flag
transitions, draft uniqueness, immutability enforcement (Postgres triggers), RLS
isolation (Postgres), CTE scope injection, read-only enforcement, parameterized
queries, schema-per-version, hard delete with CASCADE, workspace isolation, type
discrimination (tabular, prose, artifact_ref, external_ref), and optimistic
concurrency retries. Real databases (SQLite in-memory, Postgres via
testcontainers).

**Ledger routes** (`apps/ledger/src/routes.test.ts`): HTTP endpoint integration
tests covering all 11 routes.

**Resource guidance** (`packages/resources/`): `buildResourceGuidance()` and
`buildDeclarationGuidance()` formatting, category assignment, unavailable
artifact omission.

**Backend routes** (`apps/atlasd/routes/workspaces/resources.test.ts`): List,
detail, export, upload, replace, delete endpoint behavior including error cases.

**Agent tool evals** (`tools/evals/agents/resource-tools/`): LLM-judged evals
measuring agent SQL generation accuracy against the draft CTE pattern. Separate
eval suites for SQLite and Postgres dialects.

**Clarifying questions eval**: 8 E2E cases testing conversation agent's ability
to ask about persistent data storage during workspace creation.

**QA test plans** (`docs/qa/plans/resource-storage-redesign-cases.md`): 44 cases
covering adapter behavior, HTTP routes, upload strategy, and agent tool
integration. QA reports show 33 pass, 3 fail (addressed in retest), 2 partial,
6 skip (Postgres deferred).
