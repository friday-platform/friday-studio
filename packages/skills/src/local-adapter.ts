import { join } from "node:path";
import { type Result, stringifyError } from "@atlas/utils";
import { getAtlasHome } from "@atlas/utils/paths.server";
import type { Database } from "@db/sqlite";
import { ulid } from "ulid";
import type { CreateSkillInput, Skill, SkillSummary } from "./schemas.ts";
import { SkillDbRowSchema, SkillSummarySchema } from "./schemas.ts";
import type { SkillStorageAdapter } from "./storage.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS skills (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  instructions TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(workspace_id, name)
);
CREATE INDEX IF NOT EXISTS idx_skills_workspace ON skills(workspace_id);
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
      this.db.exec(SCHEMA);
    }
    return this.db;
  }

  async create(createdBy: string, input: CreateSkillInput): Promise<Result<Skill, string>> {
    const db = await this.getDb();
    const id = ulid();
    const now = new Date().toISOString();
    try {
      db.prepare(`
        INSERT INTO skills (id, name, description, instructions, workspace_id, created_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        input.name,
        input.description,
        input.instructions,
        input.workspaceId,
        createdBy,
        now,
        now,
      );
      return {
        ok: true,
        data: { id, ...input, createdBy, createdAt: new Date(now), updatedAt: new Date(now) },
      };
    } catch (e) {
      if (e instanceof Error && e.message.includes("UNIQUE constraint")) {
        return { ok: false, error: `Skill "${input.name}" already exists in this workspace` };
      }
      return { ok: false, error: stringifyError(e) };
    }
  }

  async get(id: string): Promise<Result<Skill | null, string>> {
    const db = await this.getDb();
    const row = db.prepare("SELECT * FROM skills WHERE id = ?").get(id);
    return { ok: true, data: row ? this.rowToSkill(row) : null };
  }

  async getByName(name: string, workspaceId: string): Promise<Result<Skill | null, string>> {
    const db = await this.getDb();
    const row = db
      .prepare("SELECT * FROM skills WHERE name = ? AND workspace_id = ?")
      .get(name, workspaceId);
    return { ok: true, data: row ? this.rowToSkill(row) : null };
  }

  async list(workspaceId: string): Promise<Result<SkillSummary[], string>> {
    const db = await this.getDb();
    const rows = db
      .prepare("SELECT name, description FROM skills WHERE workspace_id = ? ORDER BY name")
      .all(workspaceId);
    return { ok: true, data: rows.map((r) => SkillSummarySchema.parse(r)) };
  }

  async update(id: string, input: Partial<CreateSkillInput>): Promise<Result<Skill, string>> {
    const db = await this.getDb();
    const existing = db.prepare("SELECT * FROM skills WHERE id = ?").get(id);
    if (!existing) return { ok: false, error: "Skill not found" };
    const now = new Date().toISOString();
    const fields: string[] = ["updated_at = ?"];
    const values: (string | number | null)[] = [now];
    if (input.name !== undefined) {
      fields.push("name = ?");
      values.push(input.name);
    }
    if (input.description !== undefined) {
      fields.push("description = ?");
      values.push(input.description);
    }
    if (input.instructions !== undefined) {
      fields.push("instructions = ?");
      values.push(input.instructions);
    }
    values.push(id);
    db.prepare(`UPDATE skills SET ${fields.join(", ")} WHERE id = ?`).run(...values);
    const updated = db.prepare("SELECT * FROM skills WHERE id = ?").get(id);
    return { ok: true, data: this.rowToSkill(updated) };
  }

  async delete(id: string): Promise<Result<void, string>> {
    const db = await this.getDb();
    db.prepare("DELETE FROM skills WHERE id = ?").run(id);
    return { ok: true, data: undefined };
  }

  private rowToSkill(row: unknown): Skill {
    const r = SkillDbRowSchema.parse(row);
    return {
      id: r.id,
      name: r.name,
      description: r.description,
      instructions: r.instructions,
      workspaceId: r.workspace_id,
      createdBy: r.created_by,
      createdAt: new Date(r.created_at),
      updatedAt: new Date(r.updated_at),
    };
  }
}
