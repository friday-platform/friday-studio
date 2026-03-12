import { createLogger } from "@atlas/logger";
import type { JSONValue, Sql } from "postgres";
import postgres from "postgres";
import { buildPostgresSkillText } from "./postgres-skill.ts";
import { withUserContext } from "./rls.ts";
import {
  ClientError,
  type GetResourceOptions,
  type MutateResult,
  type ProvisionInput,
  type PublishResult,
  type QueryResult,
  type ResourceMetadata,
  type ResourceStorageAdapter,
  ResourceTypeSchema,
  type ResourceVersion,
  type ResourceWithData,
} from "./types.ts";
import { validateAgentSql } from "./validate-agent-sql.ts";

const logger = createLogger({ component: "ledger-postgres-adapter" });

// ---------------------------------------------------------------------------
// Row types — postgres.js returns snake_case with native JS types
// ---------------------------------------------------------------------------

/** Raw row shape from resource_metadata table. */
interface MetadataRow {
  id: string;
  user_id: string;
  workspace_id: string;
  slug: string;
  name: string;
  description: string;
  type: string;
  current_version: number;
  created_at: Date;
  updated_at: Date;
}

/** Raw row shape from resource_versions table. */
interface VersionRow {
  id: string;
  resource_id: string;
  user_id: string;
  version: number | null;
  schema: unknown;
  data: unknown;
  dirty: boolean;
  draft_version: number;
  created_at: Date;
  updated_at: Date;
}

/** Maps a Postgres row to ResourceMetadata. */
function toResourceMetadata(row: MetadataRow): ResourceMetadata {
  return {
    id: row.id,
    userId: row.user_id,
    workspaceId: row.workspace_id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    type: ResourceTypeSchema.parse(row.type),
    currentVersion: row.current_version,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/** Postgres bind parameter types accepted by sql.unsafe(). */
type BindParam = string | number | boolean | null | Date | Uint8Array;

const MAX_BIND_PARAM_BYTES = 1024 * 1024; // 1MB per string param

/** Narrows unknown params to postgres.js bind values. Throws on unsupported types or oversized strings. */
function toBindParams(params: unknown[]): BindParam[] {
  return params.map((p, i) => {
    if (typeof p === "string") {
      if (p.length > MAX_BIND_PARAM_BYTES) {
        throw new Error(
          `Bind parameter at index ${i} exceeds maximum size of ${MAX_BIND_PARAM_BYTES} bytes`,
        );
      }
      return p;
    }
    if (
      p === null ||
      typeof p === "number" ||
      typeof p === "boolean" ||
      p instanceof Date ||
      p instanceof Uint8Array
    ) {
      return p;
    }
    throw new Error(
      `Invalid bind parameter at index ${i}: expected string, number, boolean, null, Date, or Uint8Array`,
    );
  });
}

/** Type predicate: narrows unknown to JSONValue for postgres.js JSONB binding. */
function isJsonValue(value: unknown): value is JSONValue {
  if (value === null) return true;
  const t = typeof value;
  return t === "string" || t === "number" || t === "boolean" || t === "object";
}

const MAX_JSONB_BYTES = 5 * 1024 * 1024; // 5MB

/**
 * Binds a value for JSONB parameterization via postgres.js.
 * Adapter interfaces type schema/data as `unknown` (Zod-validated at the route
 * layer or read from JSONB columns). Type predicate narrows to JSONValue.
 */
function jsonb(sql: Sql, value: unknown, checkSize = false) {
  const v = value ?? null;
  if (!isJsonValue(v)) {
    throw new Error(`Cannot serialize ${typeof v} as JSONB`);
  }
  if (checkSize) {
    const serialized = JSON.stringify(v);
    if (serialized && serialized.length > MAX_JSONB_BYTES) {
      throw new Error(`JSONB payload exceeds maximum size of ${MAX_JSONB_BYTES} bytes`);
    }
  }
  return sql.json(v);
}

/** Strips Postgres internal details from error messages to prevent information leakage to agent SQL. */
function sanitizeAgentSqlError(message: string): string {
  // Use [^"]+ to match any quoted identifier — handles schema-qualified names,
  // hyphens, dots, spaces, and non-ASCII characters that \w misses.
  return message
    .replace(/\brole "[^"]+"/g, "role")
    .replace(/\bschema "[^"]+"/g, "schema")
    .replace(/\btable "[^"]+"/g, "table")
    .replace(/\brelation "[^"]+"/g, "relation")
    .replace(/\bfunction "[^"]+"/g, "function")
    .replace(/\bcolumn "[^"]+"/g, "column")
    .replace(/\btype "[^"]+"/g, "type")
    .replace(/\bdatabase "[^"]+"/g, "database");
}

/** Maps a Postgres row to ResourceVersion. JSONB columns are auto-parsed by postgres.js. */
function toResourceVersion(row: VersionRow): ResourceVersion {
  return {
    id: row.id,
    resourceId: row.resource_id,
    userId: row.user_id,
    version: row.version,
    schema: row.schema ?? {},
    data: row.data ?? {},
    dirty: row.dirty,
    draftVersion: row.draft_version ?? 0,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Pool config type
// ---------------------------------------------------------------------------

/** Configuration for the Postgres connection pool. Defaults live in config.ts. */
interface PostgresPoolConfig {
  max: number;
  idle_timeout: number;
  max_lifetime: number;
  connect_timeout: number;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

/**
 * Postgres implementation of ResourceStorageAdapter.
 * Uses RLS via withUserContext() for user-level isolation.
 * Workspace scoping is enforced at the application level.
 *
 * @param sql - Pooled Postgres connection (caller manages lifecycle)
 * @param userId - Set per-request by middleware for RLS scoping. Methods that
 *   require RLS throw if unset. init() and destroy() work without it.
 */
export class PostgresAdapter implements ResourceStorageAdapter {
  constructor(
    readonly sql: Sql,
    private userId?: string,
  ) {}

  /** Returns userId or throws — used by methods requiring RLS context. */
  private requireUserId(): string {
    if (!this.userId) {
      throw new Error("PostgresAdapter: userId is required for this operation");
    }
    return this.userId;
  }

  /**
   * Verifies agent SQL didn't escalate role or tamper with RLS context.
   * When `swallowAbortedTx` is true (error path), silently returns if the
   * transaction is in an aborted state — Postgres rejects all queries after
   * an error until ROLLBACK, so the verification can't run but the failed
   * query also couldn't have extracted data.
   */
  private async verifyAgentContext(
    tx: Sql,
    expectedUserId: string,
    op: string,
    swallowAbortedTx = false,
  ): Promise<void> {
    let ctx: { uid: string; role: string } | undefined;
    try {
      [ctx] = await tx<{ uid: string; role: string }[]>`
        SELECT current_setting('request.user_id', true) AS uid, current_user AS role
      `;
    } catch (verifyErr) {
      if (swallowAbortedTx) return;
      throw verifyErr;
    }
    if (ctx?.role !== "agent_query") {
      throw new Error(`Agent SQL escalated role — ${op} rejected`);
    }
    if (ctx?.uid !== expectedUserId) {
      throw new Error(`Agent SQL modified RLS context — ${op} rejected`);
    }
  }

  /**
   * Sets up the agent SQL sandbox: materializes draft data in a temp table,
   * grants access to agent_query role, and applies resource limits.
   * Calls `fn(tx)` after setup so the caller can execute agent SQL.
   */
  private async withAgentSandbox<T>(
    tx: Sql,
    draftData: unknown,
    draftSchema: unknown,
    fn: (tx: Sql) => Promise<T>,
  ): Promise<T> {
    await tx`CREATE TEMP TABLE draft (data JSONB, schema JSONB) ON COMMIT DROP`;
    await tx`INSERT INTO draft (data, schema) VALUES (${jsonb(tx, draftData)}, ${jsonb(tx, draftSchema)})`;
    await tx`GRANT SELECT ON TABLE draft TO agent_query`;
    await tx`SET LOCAL statement_timeout = '10s'`;
    await tx`SET LOCAL work_mem = '1MB'`;
    await tx`SET LOCAL search_path = pg_temp`;
    await tx`SET LOCAL ROLE agent_query`;
    return fn(tx);
  }

  async init(): Promise<void> {
    // Schema managed by Supabase migrations (supabase/migrations/20260227000000_create_ledger_tables.sql).
    // Verify tables exist as a sanity check.
    const [result] = await this.sql<{ exists: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'resource_metadata'
      )`;
    if (!result?.exists) {
      throw new Error(
        "Ledger tables not found — run Supabase migrations first (npx supabase db push)",
      );
    }

    // Verify agent_query role exists — required for agent SQL sandboxing.
    const [roleCheck] = await this.sql<{ exists: boolean }[]>`
      SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agent_query')`;
    if (!roleCheck?.exists) {
      throw new Error(
        "agent_query role not found — run Supabase migrations first (npx supabase db push)",
      );
    }

    // Verify `simple: false` on sql.unsafe() actually blocks multi-statement SQL.
    // This is the primary injection prevention layer — if a postgres.js update
    // changes the runtime behavior, we need to catch it at startup.
    try {
      await this.sql.unsafe("SELECT 1; SELECT 2", [], {
        // @ts-expect-error postgres.js unsafe() accepts `simple` at runtime but types omit it
        simple: false,
      });
      // If it succeeds, multi-statement protection is broken
      throw new Error(
        "SECURITY: sql.unsafe() with simple:false did not reject multi-statement SQL. " +
          "The extended query protocol enforcement may have changed in postgres.js — " +
          "agent SQL injection prevention is compromised.",
      );
    } catch (error) {
      // Expected: extended query protocol rejects multi-statement SQL.
      // Re-throw if it's our own security error (the throw above).
      if (error instanceof Error && error.message.startsWith("SECURITY:")) throw error;
      // Otherwise the rejection is expected — multi-statement protection works.
    }

    logger.debug("Ledger Postgres schema verified");
  }

  async destroy(): Promise<void> {
    await this.sql.end({ timeout: 5 });
    logger.debug("Ledger Postgres connection closed");
  }

  provision(
    workspaceId: string,
    metadata: ProvisionInput,
    initialData: unknown,
  ): Promise<ResourceMetadata> {
    const userId = this.requireUserId();

    return withUserContext(this.sql, userId, async (tx) => {
      // Check for type mismatch before upsert — silently changing type would
      // leave existing version data incoherent with the new type semantics.
      const [existing] = await tx<{ type: string }[]>`
        SELECT type FROM public.resource_metadata
        WHERE user_id = ${userId} AND workspace_id = ${workspaceId} AND slug = ${metadata.slug}
      `;
      if (existing && existing.type !== metadata.type) {
        throw new ClientError(
          `Cannot change resource type from "${existing.type}" to "${metadata.type}" for slug="${metadata.slug}". Delete and re-create instead.`,
          409,
        );
      }

      // Upsert metadata row — ON CONFLICT updates name/description only (type is immutable).
      // RETURNING eliminates a separate SELECT roundtrip (version INSERTs below
      // don't touch resource_metadata, so the returned row is final).
      const [row] = await tx<MetadataRow[]>`
        INSERT INTO public.resource_metadata
          (user_id, workspace_id, slug, name, description, type, current_version)
        VALUES
          (${userId}, ${workspaceId}, ${metadata.slug}, ${metadata.name}, ${metadata.description}, ${metadata.type}, 1)
        ON CONFLICT (user_id, workspace_id, slug) DO UPDATE SET
          name = EXCLUDED.name,
          description = EXCLUDED.description
        RETURNING id, user_id, workspace_id, slug, name, description, type, current_version, created_at, updated_at
      `;

      if (!row) {
        throw new Error(`Failed to resolve resource_metadata for slug=${metadata.slug}`);
      }
      const resourceId = row.id;

      // Upsert draft row — on conflict update schema only (preserve data)
      await tx`
        INSERT INTO public.resource_versions
          (resource_id, user_id, version, schema, data, dirty)
        VALUES
          (${resourceId}, ${userId}, ${null}, ${jsonb(tx, metadata.schema ?? {}, true)}, ${jsonb(tx, initialData ?? {}, true)}, FALSE)
        ON CONFLICT (resource_id) WHERE version IS NULL DO UPDATE SET
          schema = EXCLUDED.schema
      `;

      // Insert version 1 only if it doesn't exist yet (idempotent)
      await tx`
        INSERT INTO public.resource_versions
          (resource_id, user_id, version, schema, data, dirty)
        VALUES
          (${resourceId}, ${userId}, ${1}, ${jsonb(tx, metadata.schema ?? {}, true)}, ${jsonb(tx, initialData ?? {}, true)}, FALSE)
        ON CONFLICT (resource_id, version) DO NOTHING
      `;

      return toResourceMetadata(row);
    });
  }

  query(
    workspaceId: string,
    slug: string,
    rawSql: string,
    params?: unknown[],
  ): Promise<QueryResult> {
    const userId = this.requireUserId();

    return withUserContext(this.sql, userId, async (tx) => {
      try {
        await validateAgentSql(rawSql);
      } catch (err) {
        throw new ClientError(err instanceof Error ? err.message : String(err), 422);
      }

      // Resolve resource metadata
      const [meta] = await tx<{ id: string; type: string }[]>`
        SELECT id, type FROM public.resource_metadata
        WHERE workspace_id = ${workspaceId} AND slug = ${slug} AND user_id = ${userId}      `;

      if (!meta) {
        throw new ClientError(`Resource not found: workspace=${workspaceId} slug=${slug}`, 404);
      }

      if (meta.type !== "document") {
        throw new ClientError(
          `Query is only supported on document resources, got type="${meta.type}" for slug="${slug}"`,
        );
      }

      // Read draft data within RLS scope (as authenticated)
      const [draft] = await tx<{ data: unknown; schema: unknown }[]>`
        SELECT data, schema FROM public.resource_versions
        WHERE resource_id = ${meta.id} AND user_id = ${userId} AND version IS NULL
      `;

      if (!draft) {
        throw new ClientError(
          `Draft not found for resource: workspace=${workspaceId} slug=${slug}`,
          404,
        );
      }

      return this.withAgentSandbox(tx, draft.data, draft.schema, async (sandboxTx) => {
        let rows: Record<string, unknown>[];
        try {
          const bindParams = toBindParams(params ?? []);
          // simple: false forces extended query protocol (single-statement only).
          // Without this, empty params triggers simple protocol which allows
          // multi-statement injection (e.g., "SELECT 1; RESET ROLE").
          rows = await sandboxTx.unsafe<Record<string, unknown>[]>(rawSql, bindParams, {
            // @ts-expect-error postgres.js unsafe() accepts `simple` at runtime but types omit it
            simple: false,
          });
        } catch (error) {
          // Verify role/context even on error — a sandbox escape that also
          // throws would otherwise skip the post-execution check.
          // swallowAbortedTx=true: Postgres aborts the transaction after an
          // error, so the verification query will fail — that's OK because
          // a failed query couldn't have extracted data.
          await this.verifyAgentContext(sandboxTx, userId, "query", true);
          // Enrich error with schema context for agent self-correction.
          // Sanitize to strip Postgres internals (role/table/function names).
          const rawMessage = sanitizeAgentSqlError(
            error instanceof Error ? error.message : String(error),
          );
          const schemaContext = draft.schema
            ? `\nResource schema: ${JSON.stringify(draft.schema)}`
            : "";
          throw new Error(`Query failed on "${slug}": ${rawMessage}${schemaContext}`);
        }

        // Verify agent SQL didn't escalate role or tamper with RLS context.
        await this.verifyAgentContext(sandboxTx, userId, "query");

        return { rows: [...rows], rowCount: rows.length };
      });
    });
  }

  async mutate(
    workspaceId: string,
    slug: string,
    rawSql: string,
    params?: unknown[],
  ): Promise<MutateResult> {
    const userId = this.requireUserId();

    const maxAttempts = 3;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      // Transaction 1: read-only — resolve slug, read draft_version, execute agent SELECT
      const { resourceId, newData, draftVersion } = await withUserContext(
        this.sql,
        userId,
        async (tx) => {
          try {
            await validateAgentSql(rawSql);
          } catch (err) {
            throw new ClientError(err instanceof Error ? err.message : String(err), 422);
          }

          // Resolve resource metadata (as authenticated, RLS enforced)
          const [meta] = await tx<{ id: string; type: string }[]>`
            SELECT id, type FROM public.resource_metadata
            WHERE workspace_id = ${workspaceId} AND slug = ${slug} AND user_id = ${userId}          `;

          if (!meta) {
            throw new ClientError(`Resource not found: workspace=${workspaceId} slug=${slug}`, 404);
          }

          if (meta.type !== "document") {
            throw new ClientError(
              `Mutate is only supported on document resources, got type="${meta.type}" for slug="${slug}"`,
            );
          }

          // Read draft data + version stamp within RLS scope (as authenticated)
          const [draft] = await tx<{ data: unknown; schema: unknown; draft_version: number }[]>`
            SELECT data, schema, draft_version FROM public.resource_versions
            WHERE resource_id = ${meta.id} AND user_id = ${userId} AND version IS NULL
          `;

          if (!draft) {
            throw new ClientError(
              `Draft not found for resource: workspace=${workspaceId} slug=${slug}`,
              404,
            );
          }

          return this.withAgentSandbox(tx, draft.data, draft.schema, async (sandboxTx) => {
            let rows: Record<string, unknown>[];
            try {
              const bindParams = toBindParams(params ?? []);
              rows = await sandboxTx.unsafe<Record<string, unknown>[]>(rawSql, bindParams, {
                // @ts-expect-error postgres.js unsafe() accepts `simple` at runtime but types omit it
                simple: false,
              });
            } catch (error) {
              // Verify role/context even on error — a sandbox escape that also
              // throws would otherwise skip the post-execution check.
              // swallowAbortedTx=true: see query path comment above.
              await this.verifyAgentContext(sandboxTx, userId, "mutate", true);
              // Sanitize to strip Postgres internals (role/table/function names).
              const rawMessage = sanitizeAgentSqlError(
                error instanceof Error ? error.message : String(error),
              );
              const schemaContext = draft.schema
                ? `\nResource schema: ${JSON.stringify(draft.schema)}`
                : "";
              throw new Error(`Mutate failed on "${slug}": ${rawMessage}${schemaContext}`);
            }

            // Verify agent SQL didn't escalate role or tamper with RLS context.
            await this.verifyAgentContext(sandboxTx, userId, "mutate");

            const firstRow = rows[0];
            if (!firstRow) {
              throw new Error(
                "Mutate SELECT returned no rows — expected exactly one row with the new data value",
              );
            }
            // Extract the first column value (the computed new data)
            const firstKey = Object.keys(firstRow)[0];
            if (!firstKey) {
              throw new Error(
                "Mutate SELECT returned empty row — expected one column with the new data value",
              );
            }
            const value = firstRow[firstKey];
            return { resourceId: meta.id, newData: value, draftVersion: draft.draft_version };
          });
        },
      );

      // Transaction 2: writable — conditionally apply UPDATE only if draft_version unchanged
      const result = await withUserContext(this.sql, userId, async (tx) => {
        return await tx`
          UPDATE public.resource_versions
          SET data = ${jsonb(tx, newData, true)}, dirty = TRUE, draft_version = draft_version + 1
          WHERE resource_id = ${resourceId} AND user_id = ${userId} AND version IS NULL AND draft_version = ${draftVersion}
        `;
      });

      if (result.count > 0) {
        return { applied: true };
      }

      // Conflict detected — another mutation interleaved. Retry with fresh data.
      logger.debug("Draft version conflict, retrying mutate", {
        slug,
        attempt: attempt + 1,
        maxAttempts,
      });
    }

    throw new Error(
      `Mutate conflict on "${slug}": draft was modified concurrently (exhausted ${maxAttempts} retries)`,
    );
  }

  publish(workspaceId: string, slug: string): Promise<PublishResult> {
    const userId = this.requireUserId();

    return withUserContext(this.sql, userId, async (tx) => {
      // Resolve resource by workspace + slug.
      // FOR UPDATE serializes concurrent publishes — without it, two transactions
      // could read the same current_version and race on the UNIQUE(resource_id, version) constraint.
      const [meta] = await tx<{ id: string; current_version: number }[]>`
        SELECT id, current_version FROM public.resource_metadata
        WHERE workspace_id = ${workspaceId} AND slug = ${slug} AND user_id = ${userId}        FOR UPDATE
      `;

      if (!meta) {
        throw new ClientError(`Resource not found: workspace=${workspaceId} slug=${slug}`, 404);
      }

      // Find the draft row
      const [draft] = await tx<{ id: string; dirty: boolean }[]>`
        SELECT id, dirty FROM public.resource_versions
        WHERE resource_id = ${meta.id} AND user_id = ${userId} AND version IS NULL
      `;

      if (!draft) {
        throw new ClientError(`Draft not found for resource: ${slug}`, 404);
      }

      // No-op if draft is clean
      if (!draft.dirty) {
        return { version: null };
      }

      const newVersion = meta.current_version + 1;

      // Insert new immutable version row copying draft's schema and data.
      // resource_id and user_id use known validated values, not DB row values.
      await tx`
        INSERT INTO public.resource_versions (resource_id, user_id, version, schema, data, dirty)
        SELECT ${meta.id}, ${userId}, ${newVersion}, schema, data, FALSE
        FROM public.resource_versions WHERE id = ${draft.id} AND user_id = ${userId}
      `;

      // Bump current_version on metadata
      await tx`
        UPDATE public.resource_metadata SET current_version = ${newVersion} WHERE id = ${meta.id} AND user_id = ${userId}
      `;

      // Clear dirty flag and reset draft_version on draft
      await tx`
        UPDATE public.resource_versions SET dirty = FALSE, draft_version = 0 WHERE id = ${draft.id} AND user_id = ${userId}
      `;

      return { version: newVersion };
    });
  }

  replaceVersion(
    workspaceId: string,
    slug: string,
    data: unknown,
    schema?: unknown,
  ): Promise<ResourceVersion> {
    const userId = this.requireUserId();

    return withUserContext(this.sql, userId, async (tx) => {
      // FOR UPDATE serializes concurrent replaceVersion calls on the same resource.
      const [meta] = await tx<{ id: string; current_version: number }[]>`
        SELECT id, current_version FROM public.resource_metadata
        WHERE workspace_id = ${workspaceId} AND slug = ${slug} AND user_id = ${userId}        FOR UPDATE
      `;

      if (!meta) {
        throw new ClientError(`Resource not found: workspace=${workspaceId} slug=${slug}`, 404);
      }

      // Get draft's current schema as fallback
      const [draft] = await tx<{ schema: unknown }[]>`
        SELECT schema FROM public.resource_versions
        WHERE resource_id = ${meta.id} AND user_id = ${userId} AND version IS NULL
      `;

      if (!draft) {
        throw new ClientError(`Draft not found for resource: ${slug}`, 404);
      }

      const schemaValue = schema !== undefined ? schema : draft.schema;
      const newVersion = meta.current_version + 1;

      // Insert new immutable version row
      const [versionRow] = await tx<VersionRow[]>`
        INSERT INTO public.resource_versions (resource_id, user_id, version, schema, data, dirty)
        VALUES (${meta.id}, ${userId}, ${newVersion}, ${jsonb(tx, schemaValue, true)}, ${jsonb(tx, data ?? {}, true)}, FALSE)
        RETURNING id, resource_id, user_id, version, schema, data, dirty, draft_version, created_at, updated_at
      `;

      // Bump current_version on metadata
      await tx`
        UPDATE public.resource_metadata SET current_version = ${newVersion} WHERE id = ${meta.id} AND user_id = ${userId}
      `;

      // Reset draft to match the new version
      await tx`
        UPDATE public.resource_versions
        SET data = ${jsonb(tx, data ?? {}, true)}, schema = ${jsonb(tx, schemaValue, true)}, dirty = FALSE, draft_version = 0
        WHERE resource_id = ${meta.id} AND user_id = ${userId} AND version IS NULL
      `;

      if (!versionRow) {
        throw new Error(`Failed to insert version for resource: ${slug}`);
      }
      return toResourceVersion(versionRow);
    });
  }

  listResources(workspaceId: string): Promise<ResourceMetadata[]> {
    const userId = this.requireUserId();

    return withUserContext(this.sql, userId, async (tx) => {
      const rows = await tx<MetadataRow[]>`
        SELECT id, user_id, workspace_id, slug, name, description, type, current_version, created_at, updated_at
        FROM public.resource_metadata
        WHERE workspace_id = ${workspaceId} AND user_id = ${userId}      `;
      return rows.map(toResourceMetadata);
    });
  }

  getResource(
    workspaceId: string,
    slug: string,
    opts?: GetResourceOptions,
  ): Promise<ResourceWithData | null> {
    const userId = this.requireUserId();

    return withUserContext(this.sql, userId, async (tx) => {
      const [meta] = await tx<MetadataRow[]>`
        SELECT id, user_id, workspace_id, slug, name, description, type, current_version, created_at, updated_at
        FROM public.resource_metadata
        WHERE workspace_id = ${workspaceId} AND slug = ${slug} AND user_id = ${userId}      `;

      if (!meta) return null;

      let versionRow: VersionRow | undefined;
      if (opts?.published) {
        const rows = await tx<VersionRow[]>`
          SELECT id, resource_id, user_id, version, schema, data, dirty, draft_version, created_at, updated_at
          FROM public.resource_versions
          WHERE resource_id = ${meta.id} AND user_id = ${userId} AND version IS NOT NULL
          ORDER BY version DESC LIMIT 1
        `;
        versionRow = rows[0];
      } else {
        const rows = await tx<VersionRow[]>`
          SELECT id, resource_id, user_id, version, schema, data, dirty, draft_version, created_at, updated_at
          FROM public.resource_versions
          WHERE resource_id = ${meta.id} AND user_id = ${userId} AND version IS NULL
        `;
        versionRow = rows[0];
      }

      if (!versionRow) return null;

      return { metadata: toResourceMetadata(meta), version: toResourceVersion(versionRow) };
    });
  }

  async deleteResource(workspaceId: string, slug: string): Promise<void> {
    const userId = this.requireUserId();

    await withUserContext(this.sql, userId, async (tx) => {
      const result = await tx`
        DELETE FROM public.resource_metadata
        WHERE workspace_id = ${workspaceId} AND slug = ${slug} AND user_id = ${userId}
      `;

      if (result.count === 0) {
        throw new ClientError(`Resource not found: workspace=${workspaceId} slug=${slug}`, 404);
      }
    });
  }

  linkRef(workspaceId: string, slug: string, ref: string): Promise<ResourceVersion> {
    const userId = this.requireUserId();

    return withUserContext(this.sql, userId, async (tx) => {
      // FOR UPDATE serializes concurrent linkRef calls on the same resource.
      const [meta] = await tx<{ id: string; type: string; current_version: number }[]>`
        SELECT id, type, current_version FROM public.resource_metadata
        WHERE workspace_id = ${workspaceId} AND slug = ${slug} AND user_id = ${userId}        FOR UPDATE
      `;

      if (!meta) {
        throw new ClientError(`Resource not found: workspace=${workspaceId} slug=${slug}`, 404);
      }

      if (meta.type !== "external_ref") {
        throw new ClientError(
          `Link ref is only supported on external_ref resources, got type="${meta.type}" for slug="${slug}"`,
        );
      }

      const [draft] = await tx<{ schema: unknown }[]>`
        SELECT schema FROM public.resource_versions
        WHERE resource_id = ${meta.id} AND user_id = ${userId} AND version IS NULL
      `;

      if (!draft) {
        throw new ClientError(`Draft not found for resource: ${slug}`, 404);
      }

      const newVersion = meta.current_version + 1;
      const refValue = { ref };

      // Insert new immutable version with updated ref data
      const [versionRow] = await tx<VersionRow[]>`
        INSERT INTO public.resource_versions (resource_id, user_id, version, schema, data, dirty)
        VALUES (${meta.id}, ${userId}, ${newVersion}, ${jsonb(tx, draft.schema)}, ${jsonb(tx, refValue)}, FALSE)
        RETURNING id, resource_id, user_id, version, schema, data, dirty, draft_version, created_at, updated_at
      `;

      // Bump current_version on metadata
      await tx`
        UPDATE public.resource_metadata SET current_version = ${newVersion} WHERE id = ${meta.id} AND user_id = ${userId}
      `;

      // Reset draft to match the new version
      await tx`
        UPDATE public.resource_versions
        SET data = ${jsonb(tx, refValue)}, dirty = FALSE
        WHERE resource_id = ${meta.id} AND user_id = ${userId} AND version IS NULL
      `;

      if (!versionRow) {
        throw new Error(`Failed to insert version for resource: ${slug}`);
      }
      return toResourceVersion(versionRow);
    });
  }

  resetDraft(workspaceId: string, slug: string): Promise<void> {
    const userId = this.requireUserId();

    return withUserContext(this.sql, userId, async (tx) => {
      const [meta] = await tx<{ id: string; current_version: number }[]>`
        SELECT id, current_version FROM public.resource_metadata
        WHERE workspace_id = ${workspaceId} AND slug = ${slug} AND user_id = ${userId}
        FOR UPDATE
      `;

      if (!meta) {
        throw new ClientError(`Resource not found: workspace=${workspaceId} slug=${slug}`, 404);
      }

      const [published] = await tx<{ data: unknown; schema: unknown }[]>`
        SELECT data, schema FROM public.resource_versions
        WHERE resource_id = ${meta.id} AND user_id = ${userId} AND version = ${meta.current_version}
      `;

      if (!published) {
        throw new ClientError(`Published version not found for resource: ${slug}`, 404);
      }

      await tx`
        UPDATE public.resource_versions
        SET data = ${jsonb(tx, published.data)}, schema = ${jsonb(tx, published.schema)}, dirty = FALSE, draft_version = 0
        WHERE resource_id = ${meta.id} AND user_id = ${userId} AND version IS NULL
      `;
    });
  }

  async publishAllDirty(workspaceId: string): Promise<number> {
    const userId = this.requireUserId();

    // Find all dirty drafts for this workspace.
    const dirtyDrafts = await withUserContext(this.sql, userId, (tx) => {
      return tx<{ draft_id: string; resource_id: string; current_version: number; slug: string }[]>`
        SELECT rv.id AS draft_id, rv.resource_id, rm.current_version, rm.slug
        FROM public.resource_versions rv
        JOIN public.resource_metadata rm ON rv.resource_id = rm.id
        WHERE rm.workspace_id = ${workspaceId}
          AND rm.user_id = ${userId}
          AND rv.user_id = ${userId}
          AND rv.version IS NULL
          AND rv.dirty = TRUE
      `;
    });

    if (dirtyDrafts.length === 0) return 0;

    // Publish each resource independently — a failure on one resource
    // must not prevent others from being published.
    let published = 0;
    for (const draft of dirtyDrafts) {
      try {
        await withUserContext(this.sql, userId, async (tx) => {
          // FOR UPDATE serializes with concurrent publish() calls that also
          // lock the metadata row — prevents duplicate version numbers.
          const [meta] = await tx<{ current_version: number }[]>`
            SELECT current_version FROM public.resource_metadata
            WHERE id = ${draft.resource_id} AND user_id = ${userId}
            FOR UPDATE
          `;
          if (!meta) return;

          const newVersion = meta.current_version + 1;

          // Insert new immutable version from draft
          await tx`
            INSERT INTO public.resource_versions (resource_id, user_id, version, schema, data, dirty)
            SELECT resource_id, user_id, ${newVersion}, schema, data, FALSE
            FROM public.resource_versions WHERE id = ${draft.draft_id} AND user_id = ${userId}
          `;

          // Bump current_version on metadata
          await tx`
            UPDATE public.resource_metadata
            SET current_version = ${newVersion}
            WHERE id = ${draft.resource_id} AND user_id = ${userId}
          `;

          // Clear dirty flag and reset draft_version
          await tx`
            UPDATE public.resource_versions
            SET dirty = FALSE, draft_version = 0
            WHERE id = ${draft.draft_id} AND user_id = ${userId}
          `;
        });
        published++;
      } catch (error) {
        logger.warn("publishAllDirty: failed to publish resource", {
          workspaceId,
          slug: draft.slug,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return published;
  }

  getSkill(availableTools?: readonly string[]): Promise<string> {
    return Promise.resolve(buildPostgresSkillText(availableTools));
  }
}

/**
 * Creates a PostgresAdapter with a pooled connection.
 *
 * @param connectionString - Postgres connection URI
 * @param poolConfig - Pool tuning. Defaults live in config.ts.
 * @returns Initialized PostgresAdapter (caller must call init() separately)
 */
export function createPostgresAdapter(
  connectionString: string,
  poolConfig: PostgresPoolConfig,
): PostgresAdapter {
  const sql = postgres(connectionString, {
    max: poolConfig.max,
    idle_timeout: poolConfig.idle_timeout,
    max_lifetime: poolConfig.max_lifetime,
    connect_timeout: poolConfig.connect_timeout,
  });

  return new PostgresAdapter(sql);
}
