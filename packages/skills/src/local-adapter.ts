import { join } from "node:path";
import { createLogger } from "@atlas/logger";
import { fail, type Result, stringifyError, success } from "@atlas/utils";
import { getFridayHome } from "@atlas/utils/paths.server";
import type { Database } from "@db/sqlite";
import { customAlphabet } from "nanoid";

const nanoid = customAlphabet("abcdefghijklmnopqrstuvwxyz0123456789", 16);

import { ulid } from "ulid";
import { z } from "zod";
import type { PublishSkillInput, Skill, SkillSort, SkillSummary, VersionInfo } from "./schemas.ts";
import { SkillDbRowSchema } from "./schemas.ts";
import type { SkillStorageAdapter } from "./storage.ts";

const logger = createLogger({ name: "local-skill-storage" });

const SCHEMA = `
CREATE TABLE IF NOT EXISTS skills (
  id TEXT PRIMARY KEY,
  skill_id TEXT NOT NULL,
  namespace TEXT NOT NULL,
  name TEXT,
  version INTEGER NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  description_manual INTEGER NOT NULL DEFAULT 0,
  disabled INTEGER NOT NULL DEFAULT 0,
  frontmatter TEXT NOT NULL DEFAULT '{}',
  instructions TEXT NOT NULL DEFAULT '',
  title TEXT,
  archive BLOB,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(skill_id, version)
);

CREATE TABLE IF NOT EXISTS skill_assignments (
  skill_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  job_name TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (skill_id, workspace_id, job_name)
);

-- Partial unique index: prevents duplicate workspace-level rows under
-- SQLite's "NULL is distinct in PRIMARY KEY" semantics. Job-level rows
-- (job_name IS NOT NULL) rely on the composite PK for uniqueness.
CREATE UNIQUE INDEX IF NOT EXISTS idx_skill_assignments_workspace_unique
  ON skill_assignments (skill_id, workspace_id)
  WHERE job_name IS NULL;

CREATE INDEX IF NOT EXISTS idx_skill_assignments_workspace_job
  ON skill_assignments (workspace_id, job_name);
`;

/** One-time cleanup of tables introduced by an earlier iteration of this feature. */
const DROP_LEGACY = `
DROP TABLE IF EXISTS workspace_collection_assignments;
DROP TABLE IF EXISTS collection_members;
DROP TABLE IF EXISTS collections;
DROP TABLE IF EXISTS skill_metadata;
`;

export class LocalSkillAdapter implements SkillStorageAdapter {
  private db: Database | null = null;
  private dbPath: string;

  constructor(dbPath?: string) {
    this.dbPath = dbPath ?? join(getFridayHome(), "skills.db");
  }

  private async getDb(): Promise<Database> {
    if (!this.db) {
      // Dynamic import to avoid loading sqlite3 native binary at module load time.
      // This prevents the daemon from hanging during startup in CI.
      const { Database: SqliteDatabase } = await import("@db/sqlite");
      this.db = new SqliteDatabase(this.dbPath);
      this.migrateIfNeeded(this.db);
      // Rebuild skill_assignments BEFORE SCHEMA runs. SCHEMA creates a partial
      // unique index `WHERE job_name IS NULL`; on a pre-job-scoping DB the
      // column doesn't exist and that index fails with "no such column".
      this.dropLegacyAssignmentColumn(this.db);
      this.addJobNameColumn(this.db);
      this.db.exec(SCHEMA);
      this.db.exec(DROP_LEGACY);
    }
    return this.db;
  }

  /**
   * Add `job_name` column + partial unique index to an existing
   * skill_assignments table. SQLite can't alter a PRIMARY KEY in
   * place, so this rebuilds the table: create new, copy rows with
   * `NULL AS job_name`, drop old, rename.
   *
   * Idempotent — early-returns if the column already exists. Wrapped
   * in BEGIN/COMMIT so a partial failure doesn't leave a
   * half-migrated table.
   */
  private addJobNameColumn(db: Database): void {
    const cols = db.prepare("PRAGMA table_info(skill_assignments)").all() as { name: string }[];
    if (cols.length === 0) return; // fresh DB — SCHEMA will create the table with job_name
    if (cols.some((c) => c.name === "job_name")) return;

    db.exec(`
      BEGIN;
      CREATE TABLE skill_assignments_new (
        skill_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        job_name TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (skill_id, workspace_id, job_name)
      );
      INSERT INTO skill_assignments_new (skill_id, workspace_id, job_name, created_at)
        SELECT skill_id, workspace_id, NULL AS job_name, created_at FROM skill_assignments;
      DROP TABLE skill_assignments;
      ALTER TABLE skill_assignments_new RENAME TO skill_assignments;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_skill_assignments_workspace_unique
        ON skill_assignments (skill_id, workspace_id)
        WHERE job_name IS NULL;
      CREATE INDEX IF NOT EXISTS idx_skill_assignments_workspace_job
        ON skill_assignments (workspace_id, job_name);
      COMMIT;
    `);
  }

  /**
   * Drop pinned_version from skill_assignments if a previous iteration added it.
   * Runs BEFORE `addJobNameColumn` so a table with both pinned_version AND
   * job_name (unlikely but possible mid-upgrade) ends up with just job_name.
   */
  private dropLegacyAssignmentColumn(db: Database): void {
    const cols = db.prepare("PRAGMA table_info(skill_assignments)").all() as { name: string }[];
    if (cols.some((c) => c.name === "pinned_version")) {
      const hasJobName = cols.some((c) => c.name === "job_name");
      const selectClause = hasJobName
        ? "skill_id, workspace_id, job_name, created_at"
        : "skill_id, workspace_id, NULL AS job_name, created_at";
      db.exec(`
        CREATE TABLE skill_assignments_new (
          skill_id TEXT NOT NULL,
          workspace_id TEXT NOT NULL,
          job_name TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (skill_id, workspace_id, job_name)
        );
        INSERT INTO skill_assignments_new (skill_id, workspace_id, job_name, created_at)
          SELECT ${selectClause} FROM skill_assignments;
        DROP TABLE skill_assignments;
        ALTER TABLE skill_assignments_new RENAME TO skill_assignments;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_skill_assignments_workspace_unique
          ON skill_assignments (skill_id, workspace_id)
          WHERE job_name IS NULL;
        CREATE INDEX IF NOT EXISTS idx_skill_assignments_workspace_job
          ON skill_assignments (workspace_id, job_name);
      `);
    }
  }

  /** Drop the old workspace-scoped skills table if it lacks the namespace column. */
  private migrateIfNeeded(db: Database): void {
    const cols = db.prepare("PRAGMA table_info(skills)").all() as { name: string }[];
    if (cols.length === 0) return; // table doesn't exist yet — CREATE TABLE will handle it
    const hasNamespace = cols.some((c) => c.name === "namespace");
    if (!hasNamespace) {
      logger.warn(
        "Dropping skills table — old schema lacks namespace column. Skills will be recreated on next publish.",
        { columnCount: cols.length },
      );
      db.exec("DROP TABLE skills");
      return; // table dropped — CREATE TABLE will recreate with all columns
    }

    const hasTitle = cols.some((c) => c.name === "title");
    if (!hasTitle) {
      db.exec("ALTER TABLE skills ADD COLUMN title TEXT");
    }

    const hasSkillId = cols.some((c) => c.name === "skill_id");
    if (!hasSkillId) {
      logger.info("Migrating skills table: adding skill_id column and backfilling from id");
      db.exec("ALTER TABLE skills ADD COLUMN skill_id TEXT");
      // Backfill: all versions of the same (namespace, name) get the same skill_id
      // Use the id from the first version (MIN) as the shared skill_id
      db.exec(`
        UPDATE skills SET skill_id = (
          SELECT MIN(id) FROM skills s2
          WHERE s2.namespace = skills.namespace AND s2.name = skills.name
        ) WHERE skill_id IS NULL
      `);
      // Drop and recreate to update constraints (SQLite can't ALTER UNIQUE)
      // The new SCHEMA with UNIQUE(skill_id, version) will be applied by CREATE TABLE IF NOT EXISTS
      // but since table already exists, we need to recreate it
      db.exec(`
        CREATE TABLE skills_new (
          id TEXT PRIMARY KEY,
          skill_id TEXT NOT NULL,
          namespace TEXT NOT NULL,
          name TEXT,
          version INTEGER NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          description_manual INTEGER NOT NULL DEFAULT 0,
          disabled INTEGER NOT NULL DEFAULT 0,
          frontmatter TEXT NOT NULL DEFAULT '{}',
          instructions TEXT NOT NULL DEFAULT '',
          title TEXT,
          archive BLOB,
          created_by TEXT NOT NULL,
          created_at TEXT NOT NULL,
          UNIQUE(skill_id, version)
        )
      `);
      db.exec(`
        INSERT INTO skills_new (id, skill_id, namespace, name, version, description, description_manual, disabled, frontmatter, instructions, title, archive, created_by, created_at)
        SELECT id, skill_id, namespace, name, version, description, 0, 0, frontmatter, instructions, title, archive, created_by, created_at
        FROM skills
      `);
      db.exec("DROP TABLE skills");
      db.exec("ALTER TABLE skills_new RENAME TO skills");
      return; // table fully recreated — no need for further migrations
    }

    // Fix databases where skill_id was incorrectly backfilled as the per-row id
    // instead of being shared across versions of the same (namespace, name)
    const brokenSkillIds = db
      .prepare(`
        SELECT namespace, name, COUNT(DISTINCT skill_id) as id_count
        FROM skills
        WHERE name IS NOT NULL
        GROUP BY namespace, name
        HAVING COUNT(DISTINCT skill_id) > 1
      `)
      .all() as { namespace: string; name: string; id_count: number }[];

    if (brokenSkillIds.length > 0) {
      logger.info("Fixing skill_id backfill: consolidating versions", {
        count: brokenSkillIds.length,
      });
      for (const { namespace, name } of brokenSkillIds) {
        const first = db
          .prepare(
            "SELECT skill_id FROM skills WHERE namespace = ? AND name = ? ORDER BY version ASC LIMIT 1",
          )
          .get(namespace, name) as { skill_id: string };
        db.prepare("UPDATE skills SET skill_id = ? WHERE namespace = ? AND name = ?").run(
          first.skill_id,
          namespace,
          name,
        );
      }
    }

    const hasDescriptionManual = cols.some((c) => c.name === "description_manual");
    if (!hasDescriptionManual) {
      db.exec("ALTER TABLE skills ADD COLUMN description_manual INTEGER NOT NULL DEFAULT 0");
    }

    const hasDisabled = cols.some((c) => c.name === "disabled");
    if (!hasDisabled) {
      db.exec("ALTER TABLE skills ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0");
    }
  }

  async create(namespace: string, createdBy: string): Promise<Result<{ skillId: string }, string>> {
    const db = await this.getDb();
    const id = ulid();
    const skillId = nanoid();
    const now = new Date().toISOString();

    try {
      db.prepare(`
        INSERT INTO skills (id, skill_id, namespace, name, version, description, description_manual, disabled, frontmatter, instructions, archive, created_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        skillId,
        namespace,
        null, // name is null for draft skills
        1,
        "",
        0,
        0,
        "{}",
        "",
        null,
        createdBy,
        now,
      );
      return success({ skillId });
    } catch (e) {
      return fail(stringifyError(e));
    }
  }

  async publish(
    namespace: string,
    name: string,
    createdBy: string,
    input: PublishSkillInput,
  ): Promise<Result<{ id: string; version: number; name: string; skillId: string }, string>> {
    const db = await this.getDb();
    const id = ulid();
    const now = new Date().toISOString();

    // Resolve skillId: use provided value, look up by (namespace, name), or generate new
    let skillId = input.skillId;
    if (!skillId) {
      const existing = db
        .prepare("SELECT skill_id FROM skills WHERE namespace = ? AND name = ? LIMIT 1")
        .get(namespace, name) as { skill_id: string } | undefined;
      skillId = existing?.skill_id ?? nanoid();
    }

    const row = db
      .prepare("SELECT MAX(version) as max_version FROM skills WHERE skill_id = ?")
      .get(skillId) as { max_version: number | null } | undefined;
    const version = (row?.max_version ?? 0) + 1;

    // Preserve archive from previous version when not provided
    let archive = input.archive ?? null;
    if (!archive && version > 1) {
      const prev = db
        .prepare("SELECT archive FROM skills WHERE skill_id = ? AND version = ? LIMIT 1")
        .get(skillId, version - 1) as { archive: Uint8Array | null } | undefined;
      archive = prev?.archive ? new Uint8Array(prev.archive) : null;
    }

    try {
      // If skillId was explicitly provided and name changed, update all previous versions
      if (input.skillId) {
        db.prepare("UPDATE skills SET name = ? WHERE skill_id = ?").run(name, skillId);
      }

      db.prepare(`
        INSERT INTO skills (id, skill_id, namespace, name, version, description, description_manual, disabled, frontmatter, instructions, archive, created_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        skillId,
        namespace,
        name,
        version,
        input.description ?? "",
        input.descriptionManual ? 1 : 0,
        0,
        JSON.stringify(input.frontmatter ?? {}),
        input.instructions,
        archive,
        createdBy,
        now,
      );

      return success({ id, version, name, skillId });
    } catch (e) {
      return fail(stringifyError(e));
    }
  }

  async get(
    namespace: string,
    name: string,
    version?: number,
  ): Promise<Result<Skill | null, string>> {
    const db = await this.getDb();
    const row =
      version !== undefined
        ? db
            .prepare("SELECT * FROM skills WHERE namespace = ? AND name = ? AND version = ?")
            .get(namespace, name, version)
        : db
            .prepare(
              "SELECT * FROM skills WHERE namespace = ? AND name = ? ORDER BY version DESC LIMIT 1",
            )
            .get(namespace, name);
    return success(row ? this.rowToSkill(row) : null);
  }

  async getById(id: string): Promise<Result<Skill | null, string>> {
    const db = await this.getDb();
    const row = db.prepare("SELECT * FROM skills WHERE id = ?").get(id);
    return success(row ? this.rowToSkill(row) : null);
  }

  async getBySkillId(skillId: string): Promise<Result<Skill | null, string>> {
    const db = await this.getDb();
    const row = db
      .prepare("SELECT * FROM skills WHERE skill_id = ? ORDER BY version DESC LIMIT 1")
      .get(skillId);
    return success(row ? this.rowToSkill(row) : null);
  }

  async list(
    namespace?: string,
    query?: string,
    includeAll?: boolean,
    sort: SkillSort = "name",
  ): Promise<Result<SkillSummary[], string>> {
    const db = await this.getDb();

    // Build a query that returns one row per skill_id with the latest version info
    let sql = `
      SELECT s.id, s.skill_id, s.namespace, s.name, s.description, s.disabled, s.version as latestVersion, s.created_at, s.frontmatter
      FROM skills s
      INNER JOIN (
        SELECT skill_id, MAX(version) as max_version
        FROM skills
        GROUP BY skill_id
      ) latest ON s.skill_id = latest.skill_id AND s.version = latest.max_version
    `;

    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (!includeAll) {
      conditions.push("s.name IS NOT NULL");
      conditions.push("s.description != ''");
      conditions.push("s.disabled = 0");
    }
    if (namespace) {
      conditions.push("s.namespace = ?");
      params.push(namespace);
    }
    if (query) {
      conditions.push("(s.name LIKE ? OR s.description LIKE ?)");
      params.push(`%${query}%`, `%${query}%`);
    }

    if (conditions.length > 0) {
      sql += ` WHERE ${conditions.join(" AND ")}`;
    }

    const orderClause =
      sort === "createdAt" ? " ORDER BY s.created_at DESC" : " ORDER BY s.namespace, s.name";
    sql += orderClause;

    const rows = db.prepare(sql).all(...params) as {
      id: string;
      skill_id: string;
      namespace: string;
      name: string | null;
      description: string;
      disabled: number;
      latestVersion: number;
      created_at: string;
      frontmatter: string;
    }[];

    return success(
      rows.map((r) => {
        const fm = safeParseFrontmatter(r.frontmatter);
        return {
          id: r.id,
          skillId: r.skill_id,
          namespace: r.namespace,
          name: r.name,
          description: r.description,
          disabled: r.disabled !== 0,
          latestVersion: r.latestVersion,
          createdAt: new Date(r.created_at),
          source: typeof fm.source === "string" ? fm.source : undefined,
        };
      }),
    );
  }

  async listVersions(namespace: string, name: string): Promise<Result<VersionInfo[], string>> {
    const db = await this.getDb();
    const rows = db
      .prepare(
        "SELECT version, created_at, created_by FROM skills WHERE namespace = ? AND name = ? ORDER BY version DESC",
      )
      .all(namespace, name) as { version: number; created_at: string; created_by: string }[];

    return success(
      rows.map((r) => ({
        version: r.version,
        createdAt: new Date(r.created_at),
        createdBy: r.created_by,
      })),
    );
  }

  async deleteVersion(
    namespace: string,
    name: string,
    version: number,
  ): Promise<Result<void, string>> {
    const db = await this.getDb();
    db.prepare("DELETE FROM skills WHERE namespace = ? AND name = ? AND version = ?").run(
      namespace,
      name,
      version,
    );
    return success(undefined);
  }

  async setDisabled(skillId: string, disabled: boolean): Promise<Result<void, string>> {
    const db = await this.getDb();
    db.prepare("UPDATE skills SET disabled = ? WHERE skill_id = ?").run(disabled ? 1 : 0, skillId);
    return success(undefined);
  }

  async deleteSkill(skillId: string): Promise<Result<void, string>> {
    const db = await this.getDb();
    db.prepare("DELETE FROM skill_assignments WHERE skill_id = ?").run(skillId);
    db.prepare("DELETE FROM skills WHERE skill_id = ?").run(skillId);
    return success(undefined);
  }

  // ─── SCOPED LISTING ─────────────────────────────────────────────────────────

  async listAssigned(workspaceId: string): Promise<Result<SkillSummary[], string>> {
    const db = await this.getDb();
    // Workspace-level only — job-level rows (job_name IS NOT NULL) are
    // listed separately via listAssignmentsForJob() so they remain
    // isolated to their owning job.
    const rows = db
      .prepare(`
        SELECT s.id, s.skill_id, s.namespace, s.name, s.description, s.disabled, s.version as latestVersion, s.created_at, s.frontmatter
        FROM skills s
        INNER JOIN (
          SELECT skill_id, MAX(version) as max_version
          FROM skills
          GROUP BY skill_id
        ) latest ON s.skill_id = latest.skill_id AND s.version = latest.max_version
        INNER JOIN skill_assignments sa ON s.skill_id = sa.skill_id
        WHERE sa.workspace_id = ?
          AND sa.job_name IS NULL
          AND s.name IS NOT NULL
          AND s.description != ''
          AND s.disabled = 0
        ORDER BY s.namespace, s.name
      `)
      .all(workspaceId) as SkillRow[];
    return success(rows.map(rowToSummary));
  }

  // ─── ASSIGNMENTS ────────────────────────────────────────────────────────────

  async assignSkill(skillId: string, workspaceId: string): Promise<Result<void, string>> {
    const db = await this.getDb();
    db.prepare(`
      INSERT OR IGNORE INTO skill_assignments (skill_id, workspace_id) VALUES (?, ?)
    `).run(skillId, workspaceId);
    return success(undefined);
  }

  async unassignSkill(skillId: string, workspaceId: string): Promise<Result<void, string>> {
    const db = await this.getDb();
    // Workspace-level only — job-level assignments survive unless the
    // caller explicitly unassigns them via unassignFromJob().
    db.prepare(
      "DELETE FROM skill_assignments WHERE skill_id = ? AND workspace_id = ? AND job_name IS NULL",
    ).run(skillId, workspaceId);
    return success(undefined);
  }

  async listAssignments(skillId: string): Promise<Result<string[], string>> {
    const db = await this.getDb();
    // DISTINCT because a skill can have a workspace-level row AND one
    // or more job-level rows in the same workspace; callers expect
    // one entry per workspace.
    const rows = db
      .prepare("SELECT DISTINCT workspace_id FROM skill_assignments WHERE skill_id = ?")
      .all(skillId) as { workspace_id: string }[];
    return success(rows.map((r) => r.workspace_id));
  }

  // ─── JOB-LEVEL ASSIGNMENTS ──────────────────────────────────────────────────

  async assignToJob(
    skillId: string,
    workspaceId: string,
    jobName: string,
  ): Promise<Result<void, string>> {
    const db = await this.getDb();
    try {
      db.prepare(
        "INSERT OR IGNORE INTO skill_assignments (skill_id, workspace_id, job_name) VALUES (?, ?, ?)",
      ).run(skillId, workspaceId, jobName);
      return success(undefined);
    } catch (e) {
      return fail(stringifyError(e));
    }
  }

  async unassignFromJob(
    skillId: string,
    workspaceId: string,
    jobName: string,
  ): Promise<Result<void, string>> {
    const db = await this.getDb();
    try {
      db.prepare(
        "DELETE FROM skill_assignments WHERE skill_id = ? AND workspace_id = ? AND job_name = ?",
      ).run(skillId, workspaceId, jobName);
      return success(undefined);
    } catch (e) {
      return fail(stringifyError(e));
    }
  }

  async listAssignmentsForJob(
    workspaceId: string,
    jobName: string,
  ): Promise<Result<SkillSummary[], string>> {
    const db = await this.getDb();
    // Job-level only — workspace-level (job_name IS NULL) rows come
    // back through listAssigned(). Callers that want the union for a
    // given (workspace, job) should compose with resolveVisibleSkills.
    const rows = db
      .prepare(`
        SELECT s.id, s.skill_id, s.namespace, s.name, s.description, s.disabled, s.version as latestVersion, s.created_at, s.frontmatter
        FROM skills s
        INNER JOIN (
          SELECT skill_id, MAX(version) as max_version
          FROM skills
          GROUP BY skill_id
        ) latest ON s.skill_id = latest.skill_id AND s.version = latest.max_version
        INNER JOIN skill_assignments sa ON s.skill_id = sa.skill_id
        WHERE sa.workspace_id = ?
          AND sa.job_name = ?
          AND s.name IS NOT NULL
          AND s.description != ''
          AND s.disabled = 0
        ORDER BY s.namespace, s.name
      `)
      .all(workspaceId, jobName) as SkillRow[];
    return success(rows.map(rowToSummary));
  }

  private rowToSkill(row: unknown): Skill {
    const r = SkillDbRowSchema.parse(row);
    return {
      id: r.id,
      skillId: r.skill_id,
      namespace: r.namespace,
      name: r.name,
      version: r.version,
      description: r.description,
      descriptionManual: r.description_manual !== 0,
      disabled: r.disabled !== 0,
      frontmatter: z.record(z.string(), z.unknown()).parse(JSON.parse(r.frontmatter)),
      instructions: r.instructions,
      archive: r.archive,
      createdBy: r.created_by,
      createdAt: new Date(r.created_at),
    };
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

interface SkillRow {
  id: string;
  skill_id: string;
  namespace: string;
  name: string | null;
  description: string;
  disabled: number;
  latestVersion: number;
  created_at: string;
  frontmatter?: string;
}

function rowToSummary(r: SkillRow): SkillSummary {
  const fm = r.frontmatter ? safeParseFrontmatter(r.frontmatter) : {};
  return {
    id: r.id,
    skillId: r.skill_id,
    namespace: r.namespace,
    name: r.name,
    description: r.description,
    disabled: r.disabled !== 0,
    latestVersion: r.latestVersion,
    createdAt: new Date(r.created_at),
    source: typeof fm.source === "string" ? fm.source : undefined,
  };
}

/**
 * Defensive JSON.parse for the `frontmatter` column. We only need a plain
 * record out; bad rows return `{}` so the list endpoint never 500s on a
 * corrupt row (frontmatter is user-controlled input).
 */
function safeParseFrontmatter(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
