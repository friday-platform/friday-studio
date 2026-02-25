import { join } from "node:path";
import { createLogger } from "@atlas/logger";
import { fail, type Result, stringifyError, success } from "@atlas/utils";
import { getAtlasHome } from "@atlas/utils/paths.server";
import type { Database } from "@db/sqlite";
import { ulid } from "ulid";
import { z } from "zod";
import type { PublishSkillInput, Skill, SkillSummary, VersionInfo } from "./schemas.ts";
import { SkillDbRowSchema } from "./schemas.ts";
import type { SkillStorageAdapter } from "./storage.ts";

const logger = createLogger({ name: "local-skill-storage" });

const SCHEMA = `
CREATE TABLE IF NOT EXISTS skills (
  id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL,
  name TEXT NOT NULL,
  version INTEGER NOT NULL,
  description TEXT NOT NULL,
  frontmatter TEXT NOT NULL DEFAULT '{}',
  instructions TEXT NOT NULL,
  archive BLOB,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(namespace, name, version)
);
`;

export class LocalSkillAdapter implements SkillStorageAdapter {
  private db: Database | null = null;
  private dbPath: string;

  constructor(dbPath?: string) {
    this.dbPath = dbPath ?? join(getAtlasHome(), "skills.db");
  }

  private async getDb(): Promise<Database> {
    if (!this.db) {
      // Dynamic import to avoid loading sqlite3 native binary at module load time.
      // This prevents the daemon from hanging during startup in CI.
      const { Database: SqliteDatabase } = await import("@db/sqlite");
      this.db = new SqliteDatabase(this.dbPath);
      this.migrateIfNeeded(this.db);
      this.db.exec(SCHEMA);
    }
    return this.db;
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
    }
  }

  async publish(
    namespace: string,
    name: string,
    createdBy: string,
    input: PublishSkillInput,
  ): Promise<Result<{ id: string; version: number }, string>> {
    const db = await this.getDb();
    const id = ulid();
    const now = new Date().toISOString();

    const row = db
      .prepare("SELECT MAX(version) as max_version FROM skills WHERE namespace = ? AND name = ?")
      .get(namespace, name) as { max_version: number | null } | undefined;
    const version = (row?.max_version ?? 0) + 1;

    try {
      db.prepare(`
        INSERT INTO skills (id, namespace, name, version, description, frontmatter, instructions, archive, created_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        namespace,
        name,
        version,
        input.description,
        JSON.stringify(input.frontmatter ?? {}),
        input.instructions,
        input.archive ?? null,
        createdBy,
        now,
      );
      return success({ id, version });
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

  async list(namespace?: string, query?: string): Promise<Result<SkillSummary[], string>> {
    const db = await this.getDb();

    // Build a query that returns one row per (namespace, name) with the latest version info
    let sql = `
      SELECT s.namespace, s.name, s.description, s.version as latestVersion
      FROM skills s
      INNER JOIN (
        SELECT namespace, name, MAX(version) as max_version
        FROM skills
        GROUP BY namespace, name
      ) latest ON s.namespace = latest.namespace AND s.name = latest.name AND s.version = latest.max_version
    `;

    const conditions: string[] = [];
    const params: (string | number)[] = [];

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
    sql += " ORDER BY s.namespace, s.name";

    const rows = db.prepare(sql).all(...params) as {
      namespace: string;
      name: string;
      description: string;
      latestVersion: number;
    }[];

    return success(rows);
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

  private rowToSkill(row: unknown): Skill {
    const r = SkillDbRowSchema.parse(row);
    return {
      id: r.id,
      namespace: r.namespace,
      name: r.name,
      version: r.version,
      description: r.description,
      frontmatter: z.record(z.string(), z.unknown()).parse(JSON.parse(r.frontmatter)),
      instructions: r.instructions,
      archive: r.archive,
      createdBy: r.created_by,
      createdAt: new Date(r.created_at),
    };
  }
}
