import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { createLogger } from "@atlas/logger";
import { Database } from "@db/sqlite";
import { buildSqliteSkillText } from "./sqlite-skill.ts";
import {
  ClientError,
  type GetResourceOptions,
  type MutateResult,
  type ProvisionInput,
  type PublishedResourceInfo,
  type PublishResult,
  type QueryResult,
  type ResourceMetadata,
  type ResourceStorageAdapter,
  ResourceTypeSchema,
  type ResourceVersion,
  type ResourceWithData,
} from "./types.ts";

const MAX_JSONB_BYTES = 5 * 1024 * 1024; // 5MB — consistent with Postgres adapter

/** Detects DML/DDL statements that should be rejected on the read-only query endpoint. */
const DML_PATTERN = /^\s*(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|REPLACE)\b/i;

/**
 * Tables that agent SQL must NOT reference. The CTE-injected `draft` table is
 * the only allowed data source. Blocking internal tables prevents schema
 * enumeration and cross-resource data access.
 */
const BLOCKED_TABLES = new Set([
  "sqlite_master",
  "sqlite_temp_master",
  "sqlite_schema",
  "sqlite_temp_schema",
  "resource_metadata",
  "resource_versions",
]);

/**
 * Lightweight agent SQL validator for SQLite. Not as thorough as the Postgres
 * AST validator, but catches the most dangerous patterns:
 *
 * 1. Multi-statement SQL (semicolons outside string literals)
 * 2. References to internal/system tables
 * 3. WITH RECURSIVE (DoS via unbounded recursion)
 *
 * The read-only database connection provides the primary safety boundary —
 * this validator adds defense-in-depth for information disclosure.
 */
function validateAgentSqlLite(rawSql: string): void {
  // Strip string literals to avoid false positives on semicolons and table names
  const stripped = rawSql.replace(/'(?:[^']|'')*'/g, "''");

  // 1. Multi-statement: reject semicolons outside strings (`.prepare()` also
  //    rejects these, but catching it here gives a clearer error message)
  if (stripped.includes(";")) {
    throw new ClientError("Only single SQL statements are allowed", 422);
  }

  // 2. System/internal table references (case-insensitive word boundary match)
  const lowerStripped = stripped.toLowerCase();
  for (const table of BLOCKED_TABLES) {
    // Match as whole word to avoid false positives (e.g. "draft_version" shouldn't match "version")
    const pattern = new RegExp(`\\b${table}\\b`, "i");
    if (pattern.test(lowerStripped)) {
      throw new ClientError(
        `Table '${table}' is not allowed. Only the 'draft' table is accessible.`,
        422,
      );
    }
  }

  // 3. Recursive CTEs
  if (/\bWITH\s+RECURSIVE\b/i.test(stripped)) {
    throw new ClientError("Recursive CTEs (WITH RECURSIVE) are not allowed", 422);
  }
}

const logger = createLogger({ component: "ledger-sqlite-adapter" });

const RESOURCE_METADATA_DDL = `CREATE TABLE IF NOT EXISTS resource_metadata (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('document', 'artifact_ref', 'external_ref')),
  current_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, workspace_id, slug)
)`;

const RESOURCE_VERSIONS_DDL = `CREATE TABLE IF NOT EXISTS resource_versions (
  id TEXT PRIMARY KEY,
  resource_id TEXT NOT NULL REFERENCES resource_metadata(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  version INTEGER,
  schema JSONB NOT NULL DEFAULT '{}',
  data JSONB NOT NULL DEFAULT '{}',
  dirty INTEGER NOT NULL DEFAULT 0,
  draft_version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (resource_id, version)
)`;

/** Enforces at most one draft per resource (NULL != NULL defeats the UNIQUE constraint). */
const DRAFT_UNIQUENESS_INDEX = `CREATE UNIQUE INDEX IF NOT EXISTS idx_one_draft_per_resource
  ON resource_versions(resource_id) WHERE version IS NULL`;

const WORKSPACE_INDEX = `CREATE INDEX IF NOT EXISTS idx_resource_metadata_workspace
  ON resource_metadata(workspace_id)`;

/** Auto-updates updated_at on resource_metadata changes. */
const UPDATED_AT_METADATA_TRIGGER = `CREATE TRIGGER IF NOT EXISTS trg_resource_metadata_updated_at
  AFTER UPDATE ON resource_metadata
  FOR EACH ROW
  WHEN NEW.updated_at = OLD.updated_at
  BEGIN
    UPDATE resource_metadata SET updated_at = datetime('now') WHERE id = NEW.id;
  END`;

/** Auto-updates updated_at on resource_versions changes. */
const UPDATED_AT_VERSIONS_TRIGGER = `CREATE TRIGGER IF NOT EXISTS trg_resource_versions_updated_at
  AFTER UPDATE ON resource_versions
  FOR EACH ROW
  WHEN NEW.updated_at = OLD.updated_at
  BEGIN
    UPDATE resource_versions SET updated_at = datetime('now') WHERE id = NEW.id;
  END`;

type BindValue = number | string | bigint | boolean | null | undefined | Uint8Array;

/**
 * Embeds a JSON string as a SQL literal for CTE injection: `json('<escaped>')`.
 *
 * Safety argument (3 layers):
 * 1. Input is always JSON.stringify output from the DB — all special chars are
 *    handled by JSON encoding. Single quotes (`'`) are the only SQL-significant
 *    char that JSON.stringify doesn't escape.
 * 2. We double all single quotes (`'` → `''`) which is standard SQL escaping.
 * 3. SQLite's `json()` function validates the input as well-formed JSON and
 *    throws on malformed input, providing a parsing boundary.
 * 4. `.prepare()` rejects multi-statement SQL, preventing `;`-based injection.
 *
 * Named bind parameters (`:name`) would avoid string interpolation entirely,
 * but @db/sqlite doesn't support mixing named CTE params with agent positional
 * params (`?` / `$N`) in a single `.all()` call.
 */
function jsonLiteral(jsonStr: string): string {
  const escaped = jsonStr.replace(/'/g, "''");
  return `json('${escaped}')`;
}

/** Narrows unknown params to SQLite bind values. Throws on unsupported types. */
function toBindValues(params: unknown[]): BindValue[] {
  return params.map((p, i) => {
    if (
      p === null ||
      p === undefined ||
      typeof p === "string" ||
      typeof p === "number" ||
      typeof p === "bigint" ||
      typeof p === "boolean" ||
      p instanceof Uint8Array
    ) {
      return p;
    }
    throw new Error(
      `Invalid bind parameter at index ${i}: expected string, number, boolean, null, or Uint8Array`,
    );
  });
}

/** Maps a raw DB row to ResourceMetadata. */
function toResourceMetadata(row: Record<string, unknown>): ResourceMetadata {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    workspaceId: String(row.workspace_id),
    slug: String(row.slug),
    name: String(row.name),
    description: String(row.description),
    type: ResourceTypeSchema.parse(row.type),
    currentVersion: Number(row.current_version),
    createdAt: `${String(row.created_at)}Z`,
    updatedAt: `${String(row.updated_at)}Z`,
  };
}

/** Maps a raw DB row to ResourceVersion. */
function toResourceVersion(row: Record<string, unknown>): ResourceVersion {
  return {
    id: String(row.id),
    resourceId: String(row.resource_id),
    userId: String(row.user_id),
    version: row.version === null ? null : Number(row.version),
    schema: row.schema ? JSON.parse(String(row.schema)) : {},
    data: row.data ? JSON.parse(String(row.data)) : {},
    dirty: Boolean(row.dirty),
    draftVersion: Number(row.draft_version ?? 0),
    createdAt: `${String(row.created_at)}Z`,
    updatedAt: `${String(row.updated_at)}Z`,
  };
}

/**
 * SQLite implementation of ResourceStorageAdapter.
 * Scoped by workspace_id only — user_id is stored but not enforced. Single-tenant only.
 */
export class SQLiteAdapter implements ResourceStorageAdapter {
  private db: Database;
  private readOnlyDb: Database | null;

  constructor(db: Database, readOnlyDb?: Database) {
    this.db = db;
    this.readOnlyDb = readOnlyDb ?? null;
  }

  async init(): Promise<void> {
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec("PRAGMA foreign_keys = ON");

    // busy_timeout is per-connection — read-only connection needs it independently
    if (this.readOnlyDb) {
      this.readOnlyDb.exec("PRAGMA busy_timeout = 5000");
    }

    this.db.exec(RESOURCE_METADATA_DDL);
    this.db.exec(RESOURCE_VERSIONS_DDL);
    this.db.exec(DRAFT_UNIQUENESS_INDEX);
    this.db.exec(WORKSPACE_INDEX);
    this.db.exec(UPDATED_AT_METADATA_TRIGGER);
    this.db.exec(UPDATED_AT_VERSIONS_TRIGGER);

    logger.debug("Ledger SQLite schema initialized");
    await Promise.resolve();
  }

  async destroy(): Promise<void> {
    if (this.readOnlyDb) {
      this.readOnlyDb.close();
    }
    this.db.close();
    logger.debug("Ledger SQLite connection closed");
    await Promise.resolve();
  }

  async provision(
    workspaceId: string,
    metadata: ProvisionInput,
    initialData: unknown,
  ): Promise<ResourceMetadata> {
    const resourceId = randomUUID();
    const schemaJson = JSON.stringify(metadata.schema ?? {});
    const dataJson = JSON.stringify(initialData ?? {});

    const txn = this.db.transaction(() => {
      // Check for type mismatch on existing resource before upsert
      const existing = this.db
        .prepare(
          "SELECT type FROM resource_metadata WHERE user_id = ? AND workspace_id = ? AND slug = ?",
        )
        .get(metadata.userId, workspaceId, metadata.slug) as { type: string } | undefined;

      if (existing && existing.type !== metadata.type) {
        throw new ClientError(
          `Cannot change resource type from "${existing.type}" to "${metadata.type}" for slug="${metadata.slug}". Delete and re-create instead.`,
          409,
        );
      }

      // Upsert metadata row
      this.db
        .prepare(
          `INSERT INTO resource_metadata (id, user_id, workspace_id, slug, name, description, type, current_version)
           VALUES (?, ?, ?, ?, ?, ?, ?, 1)
           ON CONFLICT (user_id, workspace_id, slug) DO UPDATE SET
             name = excluded.name,
             description = excluded.description`,
        )
        .run(
          resourceId,
          metadata.userId,
          workspaceId,
          metadata.slug,
          metadata.name,
          metadata.description,
          metadata.type,
        );

      // Fetch the actual row (may be existing on upsert)
      const row = this.db
        .prepare("SELECT id FROM resource_metadata WHERE workspace_id = ? AND slug = ?")
        .get(workspaceId, metadata.slug) as { id: string };

      const actualId = row.id;

      // Upsert draft row — on conflict update schema only (preserve data)
      this.db
        .prepare(
          `INSERT INTO resource_versions (id, resource_id, user_id, version, schema, data, dirty)
           VALUES (?, ?, ?, NULL, ?, ?, 0)
           ON CONFLICT (resource_id) WHERE version IS NULL DO UPDATE SET
             schema = excluded.schema`,
        )
        .run(randomUUID(), actualId, metadata.userId, schemaJson, dataJson);

      // Insert version 1 only if it doesn't exist yet (idempotent)
      this.db
        .prepare(
          `INSERT OR IGNORE INTO resource_versions (id, resource_id, user_id, version, schema, data, dirty)
           VALUES (?, ?, ?, 1, ?, ?, 0)`,
        )
        .run(randomUUID(), actualId, metadata.userId, schemaJson, dataJson);

      // Read back the full metadata row for return value
      return this.db
        .prepare("SELECT * FROM resource_metadata WHERE id = ?")
        .get(actualId) as Record<string, unknown>;
    });

    const meta = txn();

    await Promise.resolve();
    return toResourceMetadata(meta);
  }

  async query(
    workspaceId: string,
    slug: string,
    rawSql: string,
    params?: unknown[],
  ): Promise<QueryResult> {
    // Resolve resource metadata
    const meta = this.db
      .prepare("SELECT id, type FROM resource_metadata WHERE workspace_id = ? AND slug = ?")
      .get(workspaceId, slug) as { id: string; type: string } | undefined;

    if (!meta) {
      throw new ClientError(`Resource not found: workspace=${workspaceId} slug=${slug}`, 404);
    }

    if (meta.type !== "document") {
      throw new ClientError(
        `Query is only supported on document resources, got type="${meta.type}" for slug="${slug}"`,
      );
    }

    if (DML_PATTERN.test(rawSql)) {
      throw new ClientError("Query endpoint is read-only; DML statements are not allowed");
    }

    validateAgentSqlLite(rawSql);

    // Pre-fetch draft data to avoid $N parameter collision with agent SQL.
    // SQLite's ? and $N share the same positional index namespace — if the CTE
    // uses ? for resource_id, agent $1 silently binds to the wrong value.
    const draft = this.db
      .prepare(
        "SELECT data, schema FROM resource_versions WHERE resource_id = ? AND version IS NULL",
      )
      .get(meta.id) as { data: string; schema: string } | undefined;

    if (!draft) {
      throw new ClientError(
        `Draft not found for resource: workspace=${workspaceId} slug=${slug}`,
        404,
      );
    }

    // Inline draft values as JSON literals — zero CTE bind parameters.
    // See jsonLiteral() for the safety argument on why this is injection-safe.
    const wrappedSql = `WITH draft(data, schema) AS (VALUES(${jsonLiteral(draft.data)}, ${jsonLiteral(draft.schema)}))
${rawSql}`;

    const execDb = this.readOnlyDb ?? this.db;
    const bindParams = toBindValues(params ?? []);

    try {
      const rows = execDb.prepare(wrappedSql).all(...bindParams) as Record<string, unknown>[];
      await Promise.resolve();
      return { rows, rowCount: rows.length };
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message : String(error);
      const schemaContext = `\nResource schema: ${draft.schema}`;
      throw new ClientError(`Query failed on "${slug}": ${rawMessage}${schemaContext}`);
    }
  }

  async mutate(
    workspaceId: string,
    slug: string,
    rawSql: string,
    params?: unknown[],
  ): Promise<MutateResult> {
    // Resolve resource metadata (invariant across retries)
    const meta = this.db
      .prepare("SELECT id, type FROM resource_metadata WHERE workspace_id = ? AND slug = ?")
      .get(workspaceId, slug) as { id: string; type: string } | undefined;

    if (!meta) {
      throw new ClientError(`Resource not found: workspace=${workspaceId} slug=${slug}`, 404);
    }

    if (meta.type !== "document") {
      throw new ClientError(
        `Mutate is only supported on document resources, got type="${meta.type}" for slug="${slug}"`,
      );
    }

    validateAgentSqlLite(rawSql);

    const maxAttempts = 3;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      // Read draft data + version stamp. Re-fetched each retry to get fresh data.
      // Pre-fetching avoids $N parameter collision — see query() comment.
      const stamp = this.db
        .prepare(
          "SELECT data, schema, draft_version FROM resource_versions WHERE resource_id = ? AND version IS NULL",
        )
        .get(meta.id) as { data: string; schema: string; draft_version: number } | undefined;

      if (!stamp) {
        throw new ClientError(
          `Draft not found for resource: workspace=${workspaceId} slug=${slug}`,
          404,
        );
      }

      // Inline draft values as JSON literals — zero CTE bind parameters.
      // See jsonLiteral() for the safety argument on why this is injection-safe.
      const wrappedSql = `WITH draft(data, schema) AS (VALUES(${jsonLiteral(stamp.data)}, ${jsonLiteral(stamp.schema)}))
${rawSql}`;

      const execDb = this.readOnlyDb ?? this.db;
      const bindParams = toBindValues(params ?? []);

      let newData: string;
      try {
        // Use .values() to get positional arrays — avoids @db/sqlite's new Function()
        // column-name mapping which breaks on complex SQL expressions as column names
        const rows = execDb.prepare(wrappedSql).values(...bindParams) as unknown[][];
        const firstRow = rows[0];
        if (!firstRow || firstRow.length === 0) {
          throw new Error(
            "Mutate SELECT returned no rows — expected exactly one row with the new data value",
          );
        }
        // Always JSON.stringify — @db/sqlite auto-parses JSONB results into JS
        // objects/arrays, and string values need JSON encoding for JSONB storage
        newData = JSON.stringify(firstRow[0]);
        if (newData.length > MAX_JSONB_BYTES) {
          throw new Error(`JSONB payload exceeds maximum size of ${MAX_JSONB_BYTES} bytes`);
        }
      } catch (error) {
        const rawMessage = error instanceof Error ? error.message : String(error);
        const schemaContext = `\nResource schema: ${stamp.schema}`;
        throw new ClientError(`Mutate failed on "${slug}": ${rawMessage}${schemaContext}`);
      }

      // Conditionally apply UPDATE — only succeeds if draft_version hasn't changed
      const changes = this.db
        .prepare(
          `UPDATE resource_versions SET data = ?, dirty = 1, draft_version = draft_version + 1
           WHERE resource_id = ? AND version IS NULL AND draft_version = ?`,
        )
        .run(newData, meta.id, stamp.draft_version);

      if (changes > 0) {
        await Promise.resolve();
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

  async publish(workspaceId: string, slug: string): Promise<PublishResult> {
    const txn = this.db.transaction(() => {
      // Resolve resource by workspace + slug
      const meta = this.db
        .prepare(
          "SELECT id, current_version FROM resource_metadata WHERE workspace_id = ? AND slug = ?",
        )
        .get(workspaceId, slug) as { id: string; current_version: number } | undefined;

      if (!meta) {
        throw new ClientError(`Resource not found: workspace=${workspaceId} slug=${slug}`, 404);
      }

      // Find the draft row
      const draft = this.db
        .prepare(
          "SELECT id, schema, data, dirty FROM resource_versions WHERE resource_id = ? AND version IS NULL",
        )
        .get(meta.id) as { id: string; schema: string; data: string; dirty: number } | undefined;

      if (!draft) {
        throw new ClientError(`Draft not found for resource: ${slug}`, 404);
      }

      // No-op if draft is clean
      if (draft.dirty === 0) {
        return { version: null };
      }

      const newVersion = meta.current_version + 1;

      // Insert new immutable version row
      this.db
        .prepare(
          `INSERT INTO resource_versions (id, resource_id, user_id, version, schema, data, dirty)
           SELECT ?, resource_id, user_id, ?, schema, data, 0
           FROM resource_versions WHERE id = ?`,
        )
        .run(randomUUID(), newVersion, draft.id);

      // Bump current_version on metadata
      this.db
        .prepare("UPDATE resource_metadata SET current_version = ? WHERE id = ?")
        .run(newVersion, meta.id);

      // Clear dirty flag and reset draft_version on draft
      this.db
        .prepare("UPDATE resource_versions SET dirty = 0, draft_version = 0 WHERE id = ?")
        .run(draft.id);

      return { version: newVersion };
    });

    const result = txn();
    await Promise.resolve();
    return result;
  }

  async listResources(workspaceId: string): Promise<ResourceMetadata[]> {
    const rows = this.db
      .prepare("SELECT * FROM resource_metadata WHERE workspace_id = ?")
      .all(workspaceId) as Record<string, unknown>[];

    await Promise.resolve();
    return rows.map(toResourceMetadata);
  }

  async getResource(
    workspaceId: string,
    slug: string,
    opts?: GetResourceOptions,
  ): Promise<ResourceWithData | null> {
    const meta = this.db
      .prepare("SELECT * FROM resource_metadata WHERE workspace_id = ? AND slug = ?")
      .get(workspaceId, slug) as Record<string, unknown> | undefined;

    if (!meta) {
      await Promise.resolve();
      return null;
    }

    const resourceId = String(meta.id);

    let versionRow: Record<string, unknown> | undefined;
    if (opts?.published) {
      versionRow = this.db
        .prepare(
          "SELECT * FROM resource_versions WHERE resource_id = ? AND version IS NOT NULL ORDER BY version DESC LIMIT 1",
        )
        .get(resourceId) as Record<string, unknown> | undefined;
    } else {
      versionRow = this.db
        .prepare("SELECT * FROM resource_versions WHERE resource_id = ? AND version IS NULL")
        .get(resourceId) as Record<string, unknown> | undefined;
    }

    if (!versionRow) {
      await Promise.resolve();
      return null;
    }

    await Promise.resolve();
    return { metadata: toResourceMetadata(meta), version: toResourceVersion(versionRow) };
  }

  async deleteResource(workspaceId: string, slug: string): Promise<void> {
    const changes = this.db
      .prepare("DELETE FROM resource_metadata WHERE workspace_id = ? AND slug = ?")
      .run(workspaceId, slug);

    if (changes === 0) {
      throw new ClientError(`Resource not found: workspace=${workspaceId} slug=${slug}`, 404);
    }

    await Promise.resolve();
  }

  async resetDraft(workspaceId: string, slug: string): Promise<void> {
    const txn = this.db.transaction(() => {
      const meta = this.db
        .prepare(
          "SELECT id, current_version FROM resource_metadata WHERE workspace_id = ? AND slug = ?",
        )
        .get(workspaceId, slug) as { id: string; current_version: number } | undefined;

      if (!meta) {
        throw new ClientError(`Resource not found: workspace=${workspaceId} slug=${slug}`, 404);
      }

      const published = this.db
        .prepare("SELECT data, schema FROM resource_versions WHERE resource_id = ? AND version = ?")
        .get(meta.id, meta.current_version) as { data: string; schema: string } | undefined;

      if (!published) {
        throw new ClientError(`Published version not found for resource: ${slug}`, 404);
      }

      this.db
        .prepare(
          "UPDATE resource_versions SET data = ?, schema = ?, dirty = 0, draft_version = 0 WHERE resource_id = ? AND version IS NULL",
        )
        .run(published.data, published.schema, meta.id);
    });

    txn();
    await Promise.resolve();
  }

  async replaceVersion(
    workspaceId: string,
    slug: string,
    data: unknown,
    schema?: unknown,
  ): Promise<ResourceVersion> {
    const dataJson = JSON.stringify(data ?? {});

    const txn = this.db.transaction(() => {
      const meta = this.db
        .prepare(
          "SELECT id, current_version FROM resource_metadata WHERE workspace_id = ? AND slug = ?",
        )
        .get(workspaceId, slug) as { id: string; current_version: number } | undefined;

      if (!meta) {
        throw new ClientError(`Resource not found: workspace=${workspaceId} slug=${slug}`, 404);
      }

      const draft = this.db
        .prepare(
          "SELECT user_id, schema FROM resource_versions WHERE resource_id = ? AND version IS NULL",
        )
        .get(meta.id) as { user_id: string; schema: string };

      const schemaJson = schema !== undefined ? JSON.stringify(schema) : draft.schema;
      const newVersion = meta.current_version + 1;
      const versionId = randomUUID();

      this.db
        .prepare(
          `INSERT INTO resource_versions (id, resource_id, user_id, version, schema, data, dirty)
           VALUES (?, ?, ?, ?, ?, ?, 0)`,
        )
        .run(versionId, meta.id, draft.user_id, newVersion, schemaJson, dataJson);

      this.db
        .prepare("UPDATE resource_metadata SET current_version = ? WHERE id = ?")
        .run(newVersion, meta.id);

      this.db
        .prepare(
          "UPDATE resource_versions SET data = ?, schema = ?, dirty = 0, draft_version = 0 WHERE resource_id = ? AND version IS NULL",
        )
        .run(dataJson, schemaJson, meta.id);

      return this.db
        .prepare("SELECT * FROM resource_versions WHERE id = ?")
        .get(versionId) as Record<string, unknown>;
    });

    const row = txn();
    await Promise.resolve();
    return toResourceVersion(row);
  }

  async linkRef(workspaceId: string, slug: string, ref: string): Promise<ResourceVersion> {
    const refData = JSON.stringify({ ref });

    const txn = this.db.transaction(() => {
      const meta = this.db
        .prepare(
          "SELECT id, type, current_version FROM resource_metadata WHERE workspace_id = ? AND slug = ?",
        )
        .get(workspaceId, slug) as
        | { id: string; type: string; current_version: number }
        | undefined;

      if (!meta) {
        throw new ClientError(`Resource not found: workspace=${workspaceId} slug=${slug}`, 404);
      }

      if (meta.type !== "external_ref") {
        throw new ClientError(
          `Link ref is only supported on external_ref resources, got type="${meta.type}" for slug="${slug}"`,
        );
      }

      const draft = this.db
        .prepare(
          "SELECT user_id, schema FROM resource_versions WHERE resource_id = ? AND version IS NULL",
        )
        .get(meta.id) as { user_id: string; schema: string };

      const newVersion = meta.current_version + 1;
      const versionId = randomUUID();

      this.db
        .prepare(
          `INSERT INTO resource_versions (id, resource_id, user_id, version, schema, data, dirty)
           VALUES (?, ?, ?, ?, ?, ?, 0)`,
        )
        .run(versionId, meta.id, draft.user_id, newVersion, draft.schema, refData);

      this.db
        .prepare("UPDATE resource_metadata SET current_version = ? WHERE id = ?")
        .run(newVersion, meta.id);

      this.db
        .prepare(
          "UPDATE resource_versions SET data = ?, dirty = 0 WHERE resource_id = ? AND version IS NULL",
        )
        .run(refData, meta.id);

      return this.db
        .prepare("SELECT * FROM resource_versions WHERE id = ?")
        .get(versionId) as Record<string, unknown>;
    });

    const row = txn();
    await Promise.resolve();
    return toResourceVersion(row);
  }

  async publishAllDirty(workspaceId: string): Promise<PublishedResourceInfo[]> {
    // Find all dirty drafts for this workspace
    const dirtyDrafts = this.db
      .prepare(
        `SELECT rv.id AS draft_id, rv.resource_id, rv.schema, rv.data,
                rm.current_version, rm.slug
         FROM resource_versions rv
         JOIN resource_metadata rm ON rv.resource_id = rm.id
         WHERE rm.workspace_id = ? AND rv.version IS NULL AND rv.dirty = 1`,
      )
      .all(workspaceId) as {
      draft_id: string;
      resource_id: string;
      schema: string;
      data: string;
      current_version: number;
      slug: string;
    }[];

    // Publish each resource independently — a failure on one resource
    // must not prevent others from being published.
    const published: PublishedResourceInfo[] = [];
    for (const draft of dirtyDrafts) {
      try {
        this.db.transaction(() => {
          // Re-read current_version inside the transaction to avoid stale values
          // from the listing query (consistent with Postgres FOR UPDATE pattern).
          const meta = this.db
            .prepare("SELECT current_version FROM resource_metadata WHERE id = ?")
            .get(draft.resource_id) as { current_version: number } | undefined;
          if (!meta) return;

          const newVersion = meta.current_version + 1;

          // Insert new immutable version row
          this.db
            .prepare(
              `INSERT INTO resource_versions (id, resource_id, user_id, version, schema, data, dirty)
               SELECT ?, resource_id, user_id, ?, schema, data, 0
               FROM resource_versions WHERE id = ?`,
            )
            .run(randomUUID(), newVersion, draft.draft_id);

          // Bump current_version on metadata
          this.db
            .prepare("UPDATE resource_metadata SET current_version = ? WHERE id = ?")
            .run(newVersion, draft.resource_id);

          // Clear dirty flag and reset draft_version
          this.db
            .prepare("UPDATE resource_versions SET dirty = 0, draft_version = 0 WHERE id = ?")
            .run(draft.draft_id);
        })();
        published.push({ resourceId: draft.resource_id, slug: draft.slug });
      } catch (error) {
        logger.warn("publishAllDirty: failed to publish resource", {
          workspaceId,
          slug: draft.slug,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    await Promise.resolve();
    return published;
  }

  // deno-lint-ignore require-await
  async getSkill(availableTools?: readonly string[]): Promise<string> {
    return buildSqliteSkillText(availableTools);
  }
}

/** Creates a SQLiteAdapter from a file path. Ensures parent directory exists. */
export async function createSQLiteAdapter(dbPath: string): Promise<SQLiteAdapter> {
  await mkdir(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  const readOnlyDb = new Database(dbPath, { readonly: true });
  return new SQLiteAdapter(db, readOnlyDb);
}
