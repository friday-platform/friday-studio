# Ledger

Workspace-scoped, versioned resource storage for AI agents. Sandboxed SQL
interface over JSONB with a draft/publish versioning model. Runs as HTTP service
on port 3200.

## Commands

```bash
deno task dev                                             # Start with DEV_MODE=true, hot reload
deno task start                                           # Start (needs JWT_PUBLIC_KEY_FILE)
deno task test apps/ledger/src/sqlite-adapter.test.ts     # Adapter unit tests
deno task test apps/ledger/src/routes.test.ts             # HTTP integration tests
deno task test apps/ledger/src/validate-agent-sql.test.ts # SQL validator tests
deno task test apps/ledger/src/postgres-adapter.test.ts   # Postgres tests (auto-skips if PG unavailable)
```

Postgres tests connect to `127.0.0.1:54322` by default. They read the actual
migration SQL from `supabase/migrations/` and apply it to a fresh schema.

All tests use real adapter instances — no mocking. Tests call `adapter.init()`
in setup. `routes.test.ts` builds the full HTTP stack via
`createApp(() => adapter)` and uses Hono's `app.request()` test helper.

## Common Tasks

### Add an adapter method

Four files, in order:

1. **`types.ts`** — Add method to `ResourceStorageAdapter` interface
2. **`postgres-adapter.ts`** — Implement. Write ops follow this pattern:
   ```ts
   const userId = this.requireUserId();
   return withUserContext(this.sql, userId, async (tx) => {
     const [meta] = await tx<...>`SELECT ... FOR UPDATE`; // lock metadata row
     // ... do work ...
   });
   ```
3. **`sqlite-adapter.ts`** — Implement. Write ops use `this.db.transaction()`
4. **`routes.ts`** — Add route. Define a Zod schema, use
   `zValidator("json", Schema)`, call `c.get("adapter").yourMethod()`

Route handlers access `c.get("adapter")` and `c.get("userId")` — typed env
defined in `factory.ts`.

### Add a route (without new adapter method)

Define a Zod body schema in `routes.ts`, add the handler to
`createResourceRoutes()`. All resource routes are under
`/v1/resources/:workspaceId/`. Use `zValidator("json", Schema)` for request
validation. Convention: 201 for creates, 200 for reads/updates.

### Add an allowed SQL function

1. **`validate-agent-sql.ts`** — Add the function name to the appropriate
   category array (`JSONB_FUNCTIONS`, `STRING_FUNCTIONS`, etc.)
2. **`validate-agent-sql.test.ts`** — Add a test case (existing tests
   systematically cover every allowed function)

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
Agent sends: SELECT jsonb_set(draft.data, '{quantity}', '24') FROM draft
Adapter:     1. Reads current draft data
             2. Creates temp table `draft` with current data
             3. Executes agent SELECT in sandbox → gets new value
             4. UPDATEs draft row with new value (as authenticated, not agent_query)
```

This keeps agent SQL read-only. The same sandbox works for both `query()` and
`mutate()` — agent SQL can only SELECT against a temp table called `draft`.

### Concurrency

`mutate()` uses two separate transactions (Postgres) or a read-compute-CAS loop
(SQLite) with 3 total attempts. It deliberately avoids `FOR UPDATE` because
agent SQL can take up to 10s — holding a write lock that long would starve other
operations. Optimistic concurrency via `draft_version` CAS instead.

All other write operations (`publish`, `replaceVersion`, `linkRef`,
`resetDraft`) use `FOR UPDATE` on the metadata row (Postgres) or SQLite
transactions to serialize.

If all 3 mutate attempts fail, the adapter throws a plain `Error` (not
`ClientError`), which surfaces as HTTP 500.

### Two Adapters, Different Security Postures

`SQLiteAdapter` and `PostgresAdapter` implement the same
`ResourceStorageAdapter` interface but differ significantly:

- **User isolation:** Postgres enforces via RLS (`withUserContext()` sets
  `request.user_id` + `SET LOCAL ROLE authenticated`). SQLite filters by
  `workspace_id` only — `user_id` is stored but not enforced. SQLite is not
  safe for multi-tenant production.
- **Agent SQL sandbox:** Postgres uses AST validation + `agent_query` role +
  temp table + post-execution role/context verification. SQLite uses a DML
  regex check only.
- **Schema management:** Postgres `init()` only *verifies* migrations were
  applied (run `npx supabase db push` first). SQLite `init()` creates tables.
- **Read isolation:** `createSQLiteAdapter()` opens two connections — agent SQL
  runs on the read-only connection.

### Postgres Agent SQL Security (4 layers)

1. **AST validation** (`validate-agent-sql.ts`) — Parses with `pgsql-parser`,
   walks with `@pgsql/traverse`. Rejects non-SELECT, multi-statement, SELECT
   INTO, FOR UPDATE/SHARE, WITH RECURSIVE, unapproved functions,
   schema-qualified tables, pseudo-type casts, role identity functions. Function
   allowlist organized by category in const arrays.

2. **`agent_query` role** — No table access. Can only access `pg_temp`.

3. **Temp table sandbox** (`withAgentSandbox()`) — Creates
   `TEMP TABLE draft ON COMMIT DROP`, grants SELECT to `agent_query`, sets
   `search_path = pg_temp`, `statement_timeout = 10s`, `work_mem = 1MB`.

4. **Post-execution verification** (`verifyAgentContext()`) — Confirms
   `current_user = 'agent_query'` and `request.user_id` unchanged. Runs on
   both success and error paths.

### RLS Ordering Constraint

`withUserContext()` runs three statements in strict order:
1. `set_config('request.user_id', ...)` — **must** run before role change
2. `SET LOCAL ROLE authenticated`
3. `SET LOCAL statement_timeout = '30s'`

`set_config` must execute as the connection owner because `EXECUTE ON
set_config` is revoked from `authenticated` by the migration. After the role
switch, `set_config` is physically uncallable. This is the security property
that prevents agents from tampering with their own `user_id`.

### Migration as Superuser

The Supabase migration
(`supabase/migrations/20260227000000_create_ledger_tables.sql`) must run as
superuser. It REVOKEs dangerous functions (`set_config`, `pg_sleep*`,
`pg_advisory_lock`, `pg_notify`) from PUBLIC and REVOKEs SELECT on system
catalog views from `agent_query`. Postgres `init()` verifies all of this at
startup and throws if anything is misconfigured.

## Gotchas

**SQLite CTE parameter collision.** SQLite `?` and `$N` share a positional
namespace. The adapter pre-fetches draft data and inlines it as JSON string
literals via `sqlEscape()` in the CTE — zero CTE bind parameters. Agent params
bind starting at `$1` cleanly.

**`@db/sqlite` auto-parses JSONB.** The driver auto-parses JSON columns into JS
objects. `mutate()` uses `.values()` instead of `.all()` to avoid the
`new Function()` column-name mapping that breaks on complex SQL expressions as
column names. Results need `JSON.stringify` before storage.

**`simple: false` on `sql.unsafe()`.** Without this flag, empty params triggers
simple query protocol which allows multi-statement injection (`SELECT 1; RESET
ROLE`). Forces extended query protocol. The `@ts-expect-error` is intentional —
postgres.js types omit `simple` but runtime accepts it.

**Error sanitization.** `sanitizeAgentSqlError()` strips Postgres internal
identifiers (role names, table names) from error messages before returning them
to agents. Don't bypass this — it prevents leaking DB internals.

**`await Promise.resolve()` in SQLiteAdapter.** Mechanical — makes synchronous
SQLite operations conform to the async interface. Not a bug.

**Versioned rows are immutable (Postgres only).** Postgres triggers reject
UPDATE/DELETE on rows where `version IS NOT NULL`. SQLite has no such trigger —
immutability is application-enforced only.
