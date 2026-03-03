---
name: database-rls
description: >
  Covers Row-Level Security patterns, checklists, and anti-patterns for
  user-scoped database tables. Activates when touching migrations, SQL,
  repository/adapter files, or any code that queries user-scoped tables.
  Prevents privilege escalation via withUserContext enforcement and RESTRICTIVE
  policy baselines.
user-invocable: false
---

# Database Row-Level Security (RLS)

Load this skill when writing or reviewing code that touches database tables with
user-scoped data — migrations, `*-repository.ts`, `*-adapter.ts`,
`*-storage*.ts`, or Go service files with SQL.

For schema design (tables, constraints, indexes, JSONB, soft delete) see the
`database-schema` skill.

## Contents

- Checklist: New User-Scoped Table
- Checklist: New Query on Existing RLS Table
- Policy Template (copy-paste SQL)
- withUserContext usage (TypeScript + Go)
- Anti-Patterns (ON CONFLICT, bare SQL, unset user_id)
- SECURITY DEFINER Functions
- RLS Test Pattern (6-scenario matrix)

## Checklist: New User-Scoped Table

Every table that stores user-scoped data needs ALL of these:

- [ ] `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` + `FORCE ROW LEVEL SECURITY`
      (FORCE ensures RLS applies even to the table owner — without it, owner
      role bypasses all policies)
- [ ] `GRANT ... ON TABLE ... TO authenticated` (only needed operations); for
      non-public schemas also `GRANT USAGE ON SCHEMA ... TO authenticated`
- [ ] RESTRICTIVE baseline policy (safety net — cannot be bypassed by future
      PERMISSIVE policies)
- [ ] PERMISSIVE per-operation policies (SELECT, INSERT, UPDATE, DELETE as
      needed)
- [ ] Index on `user_id` for query performance
- [ ] All application queries routed through `withUserContext()`
- [ ] RLS integration tests (see Test Pattern below)

## Checklist: New Query on Existing RLS Table

- [ ] Query runs inside `withUserContext(sql, userId, async (tx) => { ... })`
- [ ] Never use bare `this.sql` or `pool.Query` for user-scoped data
- [ ] `ON CONFLICT`: prefer `DO NOTHING`; `DO UPDATE` is safe only when the
      conflict key includes `user_id` (see Anti-Patterns)
- [ ] Cross-user lookups use SECURITY DEFINER functions, not superuser queries

## Policy Template

Replace `{schema}` and `{table}` with the appropriate values. Not all
user-scoped tables live in `public` (e.g., `cypher.keyset`).

```sql
-- 1. Enable RLS
ALTER TABLE {schema}.{table} ENABLE ROW LEVEL SECURITY;
ALTER TABLE {schema}.{table} FORCE ROW LEVEL SECURITY;

-- 2a. For non-public schemas, grant schema + function access
--     (public schema has default USAGE grant; skip this step for public tables)
GRANT USAGE ON SCHEMA {schema} TO authenticated;
GRANT EXECUTE ON FUNCTION _tempest.shortid() TO authenticated;

-- 2b. Grant table permissions (only what's needed)
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE {schema}.{table} TO authenticated;

-- 3. RESTRICTIVE baseline — cannot be bypassed by future PERMISSIVE policies
--    (SELECT ...) wrapper forces single evaluation per query, not per row
CREATE POLICY "{table}_user_isolation" ON {schema}.{table}
    AS RESTRICTIVE FOR ALL TO authenticated
    USING (user_id = (SELECT current_setting('request.user_id', true)))
    WITH CHECK (user_id = (SELECT current_setting('request.user_id', true)));

-- 4. PERMISSIVE per-operation (repeat for each needed operation)
CREATE POLICY "{table}_select" ON {schema}.{table}
    AS PERMISSIVE FOR SELECT TO authenticated
    USING (user_id = (SELECT current_setting('request.user_id', true)));

CREATE POLICY "{table}_insert" ON {schema}.{table}
    AS PERMISSIVE FOR INSERT TO authenticated
    WITH CHECK (user_id = (SELECT current_setting('request.user_id', true)));

-- Add UPDATE/DELETE policies as needed, following the same pattern.

-- 5. Performance index
CREATE INDEX IF NOT EXISTS idx_{table}_user_id ON {schema}.{table}(user_id);
```

**Why RESTRICTIVE + PERMISSIVE?** RESTRICTIVE policies are ANDed with all
PERMISSIVE policies. A RESTRICTIVE `user_id` check cannot be bypassed even if
someone adds a broad PERMISSIVE policy later.

## withUserContext

```typescript
import { withUserContext } from "../adapters/rls.ts";

const rows = await withUserContext(this.sql, userId, async (tx) => {
  return await tx`SELECT * FROM public.my_table WHERE id = ${id}`;
});
```

Go follows the same pattern — see `apps/cypher/service/rls.go`.

Both wrap queries in a transaction: `SET LOCAL ROLE authenticated` +
`set_config('request.user_id', ...)`. `SET LOCAL` scopes to the transaction —
no leakage across pooled connections.

## Anti-Patterns

### 1. `ON CONFLICT DO UPDATE` on RLS tables

**Dangerous when:** The conflict key does NOT include `user_id`. Two different
users can conflict on the same row — with RLS, `DO UPDATE` triggers a hard
violation error; without RLS, it silently overwrites. This was the root cause of
the 2026-02-09 incident: `platform_route` conflicted on `team_id` alone.

**Safe when:** The conflict key includes `user_id` (e.g.,
`ON CONFLICT (user_id, provider, label) DO UPDATE`). Cross-user conflicts are
structurally impossible — the current user's `user_id` means only their rows can
conflict. See `credential` upsert in `apps/link/src/adapters/cypher-storage-adapter.ts`.

**Default for new tables:** Prefer `ON CONFLICT DO NOTHING` + explicit
claimability check via SECURITY DEFINER function when the conflict key does not
include `user_id`.

### 2. Bare SQL outside withUserContext

Even if the query filters by `user_id` in the WHERE clause, a bug (wrong
variable, missing parameter) exposes all rows. RLS is the safety net — not
app-level auth alone.

### 3. Unset `request.user_id` matches no rows silently

`current_setting('request.user_id', true)` returns `''` (empty string) when
unset, not NULL. Since `user_id` is `TEXT` (generated by `_tempest.shortid()`),
the policy compares against `''` and silently matches nothing — queries return
empty results with no error. The real defense is `withUserContext()`: it calls
`SET LOCAL ROLE authenticated`, so without it the role is never set and queries
fail with permission denied. Always call `withUserContext()` — don't rely on
the policy comparison alone to catch missing context.

## SECURITY DEFINER Functions

For cross-user visibility (ownership checks, admin operations):

```sql
CREATE OR REPLACE FUNCTION public.is_thing_claimable(p_id TEXT, p_user_id TEXT)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT NOT EXISTS (
    SELECT 1 FROM my_table
    WHERE id = p_id AND user_id != p_user_id
  );
$$;

REVOKE EXECUTE ON FUNCTION public.is_thing_claimable FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_thing_claimable TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_thing_claimable TO service_role;
```

- `SECURITY DEFINER` runs as function owner (superuser), bypassing RLS
- `SET search_path = public` is mandatory — prevents search_path injection
- Always `REVOKE FROM PUBLIC` + explicit `GRANT` — without this, the function
  is callable via PostgREST API by unauthenticated users
- Keep the function minimal — only the cross-user check

## RLS Test Pattern

Every RLS-protected table needs integration tests covering:

| # | Scenario | Expected |
|---|----------|----------|
| 1 | User A inserts own row | Success |
| 2 | User B SELECT/UPDATE/DELETE on A's row | 0 rows (invisible) |
| 3 | User B INSERT ON CONFLICT DO NOTHING on A's key | No-op, A keeps ownership |
| 4 | User A/B list — see only own rows | Correct isolation |
| 5 | Identity spoofing (B inserts with user_id=A) | RLS violation error |
| 6 | Connection pool safety — context doesn't leak | `request.user_id` empty after tx |

Existing test examples: `apps/link/src/adapters/platform-route-repository.test.ts`,
`apps/cypher/service/rls_test.go`, `apps/cortex/service/rls_test.go`,
`apps/persona/service/rls_test.go`
