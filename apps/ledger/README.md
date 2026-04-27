# Ledger

Workspace-scoped, versioned resource storage for AI agents. Sandboxed SQL
interface over JSONB with a draft/publish versioning model. SQLite-only,
runs as HTTP service on port 3200.

## Commands

```bash
deno task dev                                           # Start with DEV_MODE=true, hot reload
deno task start                                         # Start (needs JWT_PUBLIC_KEY_FILE)
deno task test apps/ledger/src/sqlite-adapter.test.ts   # Adapter unit tests
deno task test apps/ledger/src/routes.test.ts           # HTTP integration tests
```

All tests use real adapter instances — no mocking. Tests call `adapter.init()`
in setup. `routes.test.ts` builds the full HTTP stack via
`createApp(() => adapter)` and uses Hono's `app.request()` test helper.

## Common Tasks

### Add an adapter method

Three files, in order:

1. **`types.ts`** — Add method to `ResourceStorageAdapter` interface
2. **`sqlite-adapter.ts`** — Implement. Write ops use `this.db.transaction()`
3. **`routes.ts`** — Add route. Define a Zod schema, use
   `zValidator("json", Schema)`, call `c.get("adapter").yourMethod()`

Route handlers access `c.get("adapter")` and `c.get("userId")` — typed env
defined in `factory.ts`.

### Add a route (without new adapter method)

Define a Zod body schema in `routes.ts`, add the handler to
`createResourceRoutes()`. All resource routes are under
`/v1/resources/:workspaceId/`. Use `zValidator("json", Schema)` for request
validation. Convention: 201 for creates, 200 for reads/updates.

### Add a new resource type

Add the value to `ResourceTypeSchema` in `types.ts`. Then decide which adapter
operations it supports — the type guards are in `query()`, `mutate()` (require
`document`), and `linkRef()` (requires `external_ref`).

## Key Design Decisions

### The Mutate Pattern

Agents do **not** send UPDATE/INSERT SQL. They send a **SELECT** that computes
and returns the new `data` value. The adapter extracts the first column of the
first row and writes it back as an UPDATE.

```
Agent sends: SELECT json_set(draft.data, '$.quantity', 24) FROM draft
Adapter:     1. Reads current draft data
             2. Creates temp CTE `draft` with current data
             3. Executes agent SELECT in sandbox → gets new value
             4. UPDATEs draft row with new value
```

This keeps agent SQL read-only. The same sandbox works for both `query()` and
`mutate()` — agent SQL can only SELECT against a CTE called `draft`.

### Concurrency

`mutate()` uses a read-compute-CAS loop with 3 total attempts. It deliberately
avoids long-held locks because agent SQL can take up to 10s. Optimistic
concurrency via `draft_version` CAS instead.

If all 3 mutate attempts fail, the adapter throws a plain `Error` (not
`ClientError`), which surfaces as HTTP 500.

### Security Posture

SQLite filters by `workspace_id` only — `user_id` is stored but not enforced
in queries. **SQLite is not safe for multi-tenant production**; this service
is intended for single-tenant local deployments.

Agent SQL sandbox: DML regex check rejects writes; agent SQL runs against a
read-only connection separate from the write connection.

`createSQLiteAdapter()` opens two connections — agent SQL runs on the
read-only connection.

## Gotchas

**SQLite CTE parameter collision.** SQLite `?` and `$N` share a positional
namespace. The adapter pre-fetches draft data and inlines it as JSON string
literals via `sqlEscape()` in the CTE — zero CTE bind parameters. Agent params
bind starting at `$1` cleanly.

**`@db/sqlite` auto-parses JSONB.** The driver auto-parses JSON columns into JS
objects. `mutate()` uses `.values()` instead of `.all()` to avoid the
`new Function()` column-name mapping that breaks on complex SQL expressions as
column names. Results need `JSON.stringify` before storage.

**`await Promise.resolve()` in SQLiteAdapter.** Mechanical — makes synchronous
SQLite operations conform to the async interface. Not a bug.
