---
name: database-schema
description: >
  Covers Postgres schema design: tables, constraints, indexes, FK cascading,
  soft deletes, JSONB binding, triggers, and naming conventions. Activates when
  writing or reviewing Supabase migrations, DDL, or adapter code that touches
  table structure. Also relevant when debugging constraint violations, missing
  index performance issues, or JSONB double-encoding bugs.
user-invocable: false
---

# Postgres Schema Design

Load when creating or reviewing migrations in `supabase/migrations/`, or when
writing adapter code (`*-adapter.ts`, `*-repository.ts`) that relies on table
structure.

For RLS policies see the `database-rls` skill.

## Checklist: New Table

- [ ] Primary key: `id TEXT PRIMARY KEY DEFAULT _tempest.shortid()`
- [ ] Timestamps: `created_at TIMESTAMPTZ NOT NULL DEFAULT now()`,
      `updated_at TIMESTAMPTZ NOT NULL DEFAULT now()`, `deleted_at TIMESTAMPTZ`
- [ ] `updated_at` trigger: `EXECUTE FUNCTION _tempest.updated_at()`
- [ ] Soft-delete trigger: `EXECUTE FUNCTION _tempest.soft_delete()`
- [ ] Block-deleted-update trigger:
      `EXECUTE FUNCTION _tempest.block_update_on_soft_deleted_rows()`
- [ ] FK columns have explicit `ON DELETE` behavior (CASCADE, SET NULL, or
      RESTRICT)
- [ ] FK columns have indexes (Postgres does NOT auto-index FK columns)
- [ ] CHECK constraints mirror Zod schema validation rules (`min`, `max`, enums)
- [ ] Named constraints for debuggable error messages
- [ ] RLS enabled + policies (see `database-rls` skill)

## Data Types

| Use | Don't use | Why |
|-----|-----------|-----|
| `TEXT` | `VARCHAR(n)` | Same performance, no artificial limits |
| `TIMESTAMPTZ` | `TIMESTAMP` | Always store timezone-aware |
| `NUMERIC(10,2)` | `FLOAT` | Precision for money/financial |
| `BOOLEAN` | `VARCHAR(5)` | 1 byte vs variable length |
| `CREATE TYPE ... AS ENUM` | `TEXT CHECK (IN ...)` | Type-safe, reusable, cleaner |
| `BIGINT` | `INTEGER` | Future-proof IDs (avoids 2.1B overflow) |

Exception: our IDs use `TEXT` (shortid/UUID strings), not integer sequences.

## Foreign Keys

### Cascading Rules

| Relationship | Action | Example |
|-------------|--------|---------|
| Parent-child (dependent) | `ON DELETE CASCADE` | `resource_versions.resource_id` |
| Optional association | `ON DELETE SET NULL` | `recipe.team_id` |
| Required parent (prevent orphan) | `ON DELETE RESTRICT` (default) | `project.recipe_id` |
| User ownership | `ON DELETE CASCADE` | `*.user_id → user(id)` |

### FK Indexes (MUST DO)

Postgres does NOT automatically index foreign key columns. Missing FK indexes
cause 10-100x slower JOINs and ON DELETE CASCADE operations.

```sql
-- Always pair FKs with indexes:
CREATE TABLE child (
  parent_id TEXT NOT NULL REFERENCES parent(id) ON DELETE CASCADE
);
CREATE INDEX idx_child_parent_id ON child(parent_id);
```

Find missing FK indexes:

```sql
SELECT c.conrelid::regclass AS table_name,
       a.attname AS fk_column
FROM pg_constraint c
JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
WHERE c.contype = 'f'
  AND NOT EXISTS (
    SELECT 1 FROM pg_index i
    WHERE i.indrelid = c.conrelid AND a.attnum = ANY(i.indkey)
  );
```

### Named Constraints

Always name constraints for better error messages:

```sql
-- Good: error says "fk_resource_versions_resource"
resource_id TEXT NOT NULL
  CONSTRAINT fk_resource_versions_resource
  REFERENCES parent(id) ON DELETE CASCADE,

-- Bad: error says "resource_versions_resource_id_fkey"
resource_id TEXT NOT NULL REFERENCES parent(id) ON DELETE CASCADE,
```

## CHECK Constraints

Mirror Zod validation at the database level. App bugs shouldn't corrupt data.

```sql
-- Zod: z.number().int().min(1)
current_version INTEGER NOT NULL DEFAULT 1 CHECK (current_version >= 1),

-- Zod: z.number().int().min(1).nullable()
version INTEGER CHECK (version IS NULL OR version >= 1),

-- Mutual exclusivity (one of N)
CHECK (
  (link_oauth_id IS NOT NULL)::int
  + (link_apikey_id IS NOT NULL)::int
  + (link_github_app_id IS NOT NULL)::int <= 1
)

-- XOR: exactly one must be set
CHECK ((step_id IS NULL) != (environment_id IS NULL))
```

## Indexes

### When to Create

| Scenario | Index type |
|----------|-----------|
| FK columns | B-tree (always) |
| WHERE/JOIN columns | B-tree |
| JSONB containment (`@>`) | GIN |
| JSONB specific key lookup | Expression B-tree |
| Full-text search | GIN on `tsvector` |
| Large time-series table | BRIN |
| Equality-only lookup | Hash (rare) |

### Composite Indexes

Column order matters — equality columns first, range columns last:

```sql
-- Good: status uses =, created_at uses >
CREATE INDEX idx_orders_status_date ON orders (status, created_at);

-- Leftmost prefix rule:
-- Works for: WHERE status = ?
-- Works for: WHERE status = ? AND created_at > ?
-- Does NOT work for: WHERE created_at > ?
```

### Partial Indexes

Use to enforce constraints on subsets or exclude irrelevant rows:

```sql
-- Unique slug only among non-deleted resources (allows slug reuse after delete)
CREATE UNIQUE INDEX idx_resource_metadata_workspace_slug
  ON resource_metadata(workspace_id, slug) WHERE deleted_at IS NULL;

-- Index only active rows (5-20x smaller than full index)
CREATE INDEX idx_users_active_email ON users(email) WHERE deleted_at IS NULL;
```

When using partial unique indexes with `ON CONFLICT`, the conflict target must
include the `WHERE` clause:

```sql
ON CONFLICT (workspace_id, slug) WHERE deleted_at IS NULL DO UPDATE SET ...
```

### Covering Indexes (INCLUDE)

Add non-searchable columns to enable index-only scans (2-5x faster):

```sql
CREATE INDEX idx_users_email ON users(email) INCLUDE (name, created_at);
```

Avoid for JSONB columns — they bloat the index.

### JSONB Indexes

```sql
-- GIN: for containment queries (@>, ?, ?|, ?&)
-- jsonb_ops (default): all operators, larger index
-- jsonb_path_ops: only @>, 2-3x smaller index
CREATE INDEX idx_products_attrs ON products USING GIN (attributes jsonb_path_ops);

-- Expression: for specific key lookups (->>, ->)
CREATE INDEX idx_products_brand ON products ((attributes->>'brand'));
```

## Soft Delete

### Pattern

Every table with `deleted_at` needs two triggers:

```sql
-- 1. Intercept DELETE → UPDATE SET deleted_at = now()
CREATE TRIGGER trg_{table}_soft_delete
  BEFORE DELETE ON {schema}.{table}
  FOR EACH ROW
  EXECUTE FUNCTION _tempest.soft_delete();

-- 2. Block updates on already-deleted rows
CREATE TRIGGER trg_{table}_block_deleted_update
  BEFORE UPDATE ON {schema}.{table}
  FOR EACH ROW
  EXECUTE FUNCTION _tempest.block_update_on_soft_deleted_rows();
```

Why `block_update_on_soft_deleted_rows` is a trigger and not an RLS policy: RLS
evaluates proposed values, not existing values — an RLS check on
`deleted_at IS NULL` would block the `soft_delete` trigger itself.

### Queries Must Exclude Deleted Rows

All SELECT queries on soft-deleted tables must include `AND deleted_at IS NULL`.
This is enforced at the application level — RLS policies scope by `user_id`,
not `deleted_at`.

### Unique Constraints Must Exclude Deleted Rows

Use partial unique indexes instead of table-level UNIQUE constraints:

```sql
-- Bad: prevents slug reuse after soft-delete
UNIQUE (workspace_id, slug)

-- Good: only enforces uniqueness among active rows
CREATE UNIQUE INDEX idx_workspace_slug
  ON resource_metadata(workspace_id, slug) WHERE deleted_at IS NULL;
```

## Trigger Functions

### Schema Placement

| Function type | Schema | Example |
|--------------|--------|---------|
| Reusable infrastructure | `_tempest` | `soft_delete()`, `updated_at()`, `shortid()` |
| Business logic | `public` | `is_route_claimable()` |
| Table-specific immutability | `_tempest` | `reject_versioned_row_update()` |

Always `REVOKE EXECUTE ... FROM PUBLIC` on trigger functions — defense in depth:

```sql
CREATE FUNCTION _tempest.my_trigger_fn() RETURNS trigger AS $$ ... $$;
REVOKE EXECUTE ON FUNCTION _tempest.my_trigger_fn() FROM PUBLIC;
```

### Trigger Ordering

- `BEFORE INSERT OR UPDATE` — validation, defaulting
- `BEFORE DELETE` — soft-delete interception
- `BEFORE UPDATE WHEN (condition)` — conditional triggers
- `AFTER INSERT` — auto-creating dependent records
- `AFTER DELETE OR UPDATE` — notifications, cache invalidation

## JSONB in postgres.js

### Binding Values

Never use `JSON.stringify(value)` + `::jsonb` cast — causes double-encoding.
postgres.js sends string parameters as text; `::jsonb` wraps the entire string
as a JSON string value.

```typescript
// BAD: double-encodes — jsonb_typeof returns 'string' not 'object'
await tx`UPDATE t SET data = ${JSON.stringify(obj)}::jsonb WHERE id = ${id}`;

// GOOD: sends JSONB wire type (OID 3802)
await tx`UPDATE t SET data = ${sql.json(obj)} WHERE id = ${id}`;
```

When the value is typed as `unknown` (common in adapter interfaces), use a type
predicate to narrow to `JSONValue`:

```typescript
import type { JSONValue, Sql } from "postgres";

function isJsonValue(value: unknown): value is JSONValue {
  if (value === null) return true;
  const t = typeof value;
  return t === "string" || t === "number" || t === "boolean" || t === "object";
}

function jsonb(sql: Sql, value: unknown) {
  const v = value ?? null;
  if (!isJsonValue(v)) throw new Error(`Cannot serialize ${typeof v} as JSONB`);
  return sql.json(v);
}
```

## Enum Types

Use proper Postgres ENUM types, not TEXT CHECK constraints:

```sql
-- Good: type-safe, reusable, validated by Postgres
CREATE TYPE public.resource_type AS ENUM ('document', 'artifact_ref', 'external_ref');
ALTER TABLE t ADD COLUMN type public.resource_type NOT NULL;

-- Bad: stringly-typed, easy to typo, no reuse
ALTER TABLE t ADD COLUMN type TEXT NOT NULL CHECK (type IN ('document', 'artifact_ref', 'external_ref'));
```

postgres.js handles enum values as plain strings — no special binding needed.

**Test caveat:** Dropping and recreating an enum type changes its OID. Pooled
connections cache type OIDs, causing `cache lookup failed for type XXXXX`. Fix:
use `prepare: false` in test connection options.

## Naming Conventions

| Object | Convention | Example |
|--------|-----------|---------|
| Table | `snake_case` | `resource_metadata` |
| Column | `snake_case` | `workspace_id` |
| Index | `idx_{table}_{columns}` | `idx_resource_metadata_workspace` |
| Unique index | `idx_{table}_{columns}` or `uq_{table}_{columns}` | `idx_one_draft_per_resource` |
| FK constraint | `fk_{table}_{column}` | `fk_resource_versions_resource` |
| Trigger | `trg_{table}_{purpose}` | `trg_resource_metadata_updated_at` |
| Policy | `{table}_{operation}` | `resource_metadata_select` |
| Enum type | `{domain}_type` | `resource_type` |
| Function (_tempest) | `_tempest.{verb}_{noun}()` | `_tempest.soft_delete()` |

Always use lowercase, unquoted identifiers. Quoted mixed-case identifiers
(`"userId"`) require quotes forever and break tools.

## Performance

### Autovacuum Tuning for High-Churn Tables

Tables with frequent UPDATE cycles (e.g., draft rows updated on every mutation)
accumulate dead tuples. Lower the vacuum thresholds:

```sql
ALTER TABLE resource_versions SET (
  autovacuum_vacuum_scale_factor = 0.05,   -- vacuum at 5% dead (default 20%)
  autovacuum_analyze_scale_factor = 0.02   -- analyze at 2% changes (default 10%)
);
```

### RLS Policy Performance

Wrap `current_setting()` in a subselect to cache — avoids per-row evaluation
(100x+ faster on large tables):

```sql
-- Good: evaluates once per query
USING (user_id = (SELECT current_setting('request.user_id', true)))

-- Bad: evaluates per row
USING (user_id = current_setting('request.user_id', true))
```

### Query Patterns

- **Never use `SELECT *` or `RETURNING *`** — always list columns explicitly.
  `*` breaks when columns are added/removed/reordered, pulls unnecessary data
  (especially large JSONB columns), and defeats covering indexes. Applies to
  `SELECT`, `RETURNING`, and `INSERT...SELECT`. Map column lists to typed row
  interfaces in application code.
- Use cursor-based pagination, not OFFSET (O(1) vs degrading performance)
- Batch INSERTs: `VALUES (...), (...), (...)` not individual statements
- Eliminate N+1: use `WHERE id = ANY($1::text[])` or JOINs
- Keep transactions short — no external API calls inside transactions
