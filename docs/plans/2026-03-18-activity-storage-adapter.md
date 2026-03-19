## Problem Statement

Activity storage is currently a single SQLite-backed implementation
(`LocalActivityAdapter`) with a global lazy singleton. This works for local dev
but doesn't scale to production — there's no Postgres adapter, no RLS, and the
backfill migration (`backfill.ts`) bypasses the adapter entirely to write raw
SQLite.

The resource storage system in Ledger already solves this problem with a clean
adapter pattern: SQLite for local dev, Postgres with RLS for production, HTTP
client for daemon-to-service communication. Activity storage should follow the
same pattern.

## Solution

Break activity storage into the same adapter architecture as resource storage in
Ledger:

1. Supabase migration for Postgres tables (with data backfill from Cortex
   session metadata)
2. Postgres adapter in Ledger with RLS
3. Activity HTTP routes in Ledger
4. HTTP client adapter in `packages/activity` for daemon-to-Ledger communication
5. Remove `backfill.ts` — replaced by the Supabase data migration

## Implementation

### 1. Supabase Migration

Single migration file created via `supabase migration new create_activity_tables`.

**Schema tables:**

```sql
CREATE TYPE public.activity_type AS ENUM ('session', 'resource');
CREATE TYPE public.activity_source AS ENUM ('agent', 'user');
CREATE TYPE public.activity_read_status AS ENUM ('viewed', 'dismissed');

CREATE TABLE public.activities (
  id TEXT PRIMARY KEY DEFAULT _tempest.shortid(),
  type public.activity_type NOT NULL,
  source public.activity_source NOT NULL,
  reference_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  job_id TEXT,
  user_id TEXT REFERENCES public."user"(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.activity_read_status (
  user_id TEXT NOT NULL REFERENCES public."user"(id) ON DELETE CASCADE,
  activity_id TEXT NOT NULL REFERENCES public.activities(id) ON DELETE CASCADE,
  status public.activity_read_status NOT NULL,
  PRIMARY KEY (user_id, activity_id)
);
```

**Indexes:**

```sql
CREATE INDEX idx_activities_created_at ON public.activities(created_at DESC);
CREATE INDEX idx_activities_workspace_id ON public.activities(workspace_id);
CREATE INDEX idx_activities_reference_id ON public.activities(reference_id);
CREATE INDEX idx_activities_user_id ON public.activities(user_id);
CREATE INDEX idx_activity_read_status_user ON public.activity_read_status(user_id);
```

**RLS:** Same pattern as Ledger tables — restrictive baseline policy on
`request.user_id`, permissive per-operation policies for `authenticated` role.
Activities are scoped to the user who owns them (via `user_id`).

**Data backfill from Cortex session metadata:**

Cortex stores session metadata in `cortex.object.metadata` JSONB with fields:
`session_id`, `workspace_id`, `job_name`, `status`. This is sufficient to
generate backfill titles without downloading blobs or calling LLMs.

```sql
INSERT INTO public.activities (type, source, reference_id, workspace_id, job_id, user_id, title, created_at)
SELECT
  'session'::public.activity_type,
  'agent'::public.activity_source,
  o.metadata->>'session_id',
  o.metadata->>'workspace_id',
  o.metadata->>'job_name',
  o.user_id,
  initcap(replace(replace(o.metadata->>'job_name', '-', ' '), '_', ' '))
    || ' session '
    || CASE WHEN o.metadata->>'status' = 'completed' THEN 'completed' ELSE 'failed' END,
  o.created_at
FROM cortex.object o
WHERE o.deleted_at IS NULL
  AND o.metadata->>'session_id' IS NOT NULL
  AND o.metadata->>'status' IN ('completed', 'failed')
  -- Exclude conversation workspaces and chat jobs
  AND o.metadata->>'workspace_id' NOT IN ('atlas-conversation', 'friday-conversation')
  AND o.metadata->>'job_name' != 'handle-chat'
  -- Prevent duplicate backfill
  AND NOT EXISTS (
    SELECT 1 FROM public.activities a
    WHERE a.reference_id = o.metadata->>'session_id'
  );
```

**Title format:** `initcap(replace(job_name, '-', ' '))` + ` session completed/failed`.
Example: `monday-notion-weekly-scan` becomes `Monday Notion Weekly Scan session completed`.
No LLM calls — titles derived from metadata only.

### 2. Postgres Adapter (`apps/ledger/src/activity-postgres-adapter.ts`)

Implements `ActivityStorageAdapter` using the existing `withUserContext()` RLS
wrapper from `apps/ledger/src/rls.ts`. Per-request instantiation with `userId`
for RLS context, same as `PostgresAdapter` for resources.

Methods map directly to SQL:

- `create()` — `INSERT INTO activities ... RETURNING *`, auto-insert `viewed`
  read status for user-initiated activities (same as local adapter)
- `deleteByReferenceId()` — `DELETE FROM activities WHERE reference_id = $1`
  (cascade handles read status)
- `list()` — `SELECT` with LEFT JOIN on read status, dynamic WHERE from filters,
  `LIMIT n+1` for `hasMore` detection
- `getUnreadCount()` — `COUNT(*)` where no read status row exists
- `updateReadStatus()` — `INSERT ... ON CONFLICT DO UPDATE` for each activity ID
- `markViewedBefore()` — `INSERT INTO activity_read_status SELECT ...` for
  unread activities before timestamp

### 3. Activity Routes (`apps/ledger/src/activity-routes.ts`)

HTTP routes mounted in Ledger alongside resource routes. Same shape as the
daemon's current `apps/atlasd/routes/activity.ts` but using Ledger's factory
and middleware (which provides `userId` and adapter via Hono context).

```
GET  /v1/activity              — list with filters
GET  /v1/activity/unread-count — unread count
POST /v1/activity/mark         — mark read status
POST /v1/activity              — create activity
DELETE /v1/activity/by-reference/:referenceId — delete by reference
```

### 4. Ledger Wiring (`apps/ledger/src/index.ts`, `apps/ledger/src/factory.ts`)

**factory.ts:** Add `activityAdapter: ActivityStorageAdapter` to the Hono `Env`
Variables type (alongside existing `adapter` for resources).

**index.ts:**
- Construct activity adapter at startup (same if/else as resource adapter):
  - Postgres: `new ActivityPostgresAdapter(sql, userId)` via factory
  - SQLite: shared `LocalActivityAdapter` instance
- Add middleware to inject activity adapter into context on `/v1/activity/*`
- Mount activity routes: `.route("/v1/activity", createActivityRoutes())`

### 5. HTTP Client (`packages/activity/src/ledger-client.ts`)

Implements `ActivityStorageAdapter` as an HTTP client wrapping Ledger's activity
routes. Follows the exact pattern of
`packages/resources/src/ledger-client.ts` — Hono RPC client with
`LEDGER_URL` + `ATLAS_KEY` auth.

### 6. Clean Up `packages/activity/src/storage.ts`

Strip to interface-only:

```typescript
export interface ActivityListResult {
  activities: ActivityWithReadStatus[];
  hasMore: boolean;
}

export interface ActivityStorageAdapter {
  create(input: CreateActivityInput): Promise<Activity>;
  deleteByReferenceId(referenceId: string): Promise<void>;
  list(userId: string, filters?: ActivityListFilter): Promise<ActivityListResult>;
  getUnreadCount(userId: string): Promise<number>;
  updateReadStatus(userId: string, activityIds: string[], status: ReadStatusValue): Promise<void>;
  markViewedBefore(userId: string, before: string): Promise<void>;
}
```

Remove `createActivityStorageAdapter()`, `getStorage()`, and the
`ActivityStorage` lazy singleton proxy. Callers construct adapters explicitly.

### 7. Delete `packages/activity/src/backfill.ts`

Replaced by the Supabase data migration (step 1). Remove the
`runSessionBackfill` export from `mod.ts` and the call in
`apps/atlasd/src/atlas-daemon.ts` `initialize()`.

### 8. Daemon Wiring (`apps/atlasd/src/atlas-daemon.ts`)

Replace the `ActivityStorage` global import with explicit adapter construction:

```typescript
// In initialize():
if (process.env.LEDGER_URL) {
  this.activityAdapter = createActivityLedgerClient();
} else {
  this.activityAdapter = new LocalActivityAdapter(dbPath);
}
```

`getActivityAdapter()` returns this instance instead of the global singleton.

Remove `runSessionBackfill()` call from `initialize()`.

### 9. Update `packages/activity/src/mod.ts` Exports

- Remove `runSessionBackfill` export
- Remove `ActivityStorage` export
- Add `createActivityLedgerClient` export from `ledger-client.ts`
- Keep all other exports (schemas, types, `LocalActivityAdapter`,
  title generators)

## Exclusion Rules for Activity Creation

These rules apply both in the Supabase data migration (backfill) and in the
runtime activity creation path (`WorkspaceRuntime`):

- **Workspace ID:** `atlas-conversation`, `friday-conversation` — internal
  conversation workspaces, not user-visible work
- **Job name:** `handle-chat` — auto-injected chat handler job, creates
  conversation sessions not workspace activity

The runtime already enforces these in `packages/workspace/src/runtime.ts`
(line 752-755). The Supabase migration enforces them via WHERE clause filters.

## What Doesn't Change

- `ActivityStorageAdapter` interface (6 methods — already correct)
- `LocalActivityAdapter` (SQLite for local dev — stays as-is)
- How daemon's `routes/activity.ts` works (already uses adapter via
  `getActivityAdapter()`)
- How `WorkspaceRuntime` creates activities (calls adapter, unaware of backend)
- Frontend (web-client) — talks to daemon API, doesn't know about Ledger
- Title generation (`title-generator.ts`) — still used at runtime for new
  activity creation
- `packages/activity/src/schemas.ts` — types and Zod schemas unchanged

## Testing

### Postgres adapter
- Real Postgres in test (follow `apps/ledger/src/postgres-adapter.test.ts`
  pattern if one exists, otherwise local Supabase)
- CRUD operations through RLS — verify user isolation
- `list()` with filters, pagination, `hasMore`
- `getUnreadCount()` accuracy
- `markViewedBefore()` bulk operation

### HTTP client
- Mock Ledger server, verify request/response mapping

### Supabase migration
- Verify tables created with correct schema
- Verify data backfill excludes conversation workspaces and `handle-chat` jobs
- Verify backfill title generation from `job_name` + `status`
- Verify no duplicate activities on re-run (idempotent via `NOT EXISTS`)

### Ledger activity routes
- Follow existing `apps/atlasd/routes/activity.test.ts` pattern — mock adapter,
  test HTTP layer
