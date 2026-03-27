import { join } from "node:path";
import { createLogger } from "@atlas/logger";
import { getAtlasHome } from "@atlas/utils/paths.server";
import type { Database } from "@db/sqlite";
import { ulid } from "ulid";
import { z } from "zod";
import type {
  Activity,
  ActivityListFilter,
  ActivityWithReadStatus,
  CreateActivityInput,
  ReadStatusValue,
} from "./schemas.ts";
import {
  ActivitySourceSchema,
  ActivityTypeSchema,
  ActivityWithReadStatusDbRowSchema,
  ReadStatusValueSchema,
} from "./schemas.ts";
import type { ActivityListResult, ActivityStorageAdapter } from "./storage.ts";

const logger = createLogger({ name: "local-activity-adapter" });
const countRowSchema = z.object({ count: z.number() });

const SCHEMA = `
CREATE TABLE IF NOT EXISTS activities (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  source TEXT NOT NULL,
  reference_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  job_id TEXT,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS activity_read_status (
  user_id TEXT NOT NULL,
  activity_id TEXT NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  PRIMARY KEY (user_id, activity_id)
);

CREATE INDEX IF NOT EXISTS idx_activity_read_status_user
  ON activity_read_status(user_id);

CREATE INDEX IF NOT EXISTS idx_activities_created_at
  ON activities(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_activities_workspace_id
  ON activities(workspace_id);
`;

function rowToActivityWithReadStatus(row: unknown): ActivityWithReadStatus {
  const r = ActivityWithReadStatusDbRowSchema.parse(row);
  return {
    id: r.id,
    type: ActivityTypeSchema.parse(r.type),
    source: ActivitySourceSchema.parse(r.source),
    referenceId: r.reference_id,
    workspaceId: r.workspace_id,
    jobId: r.job_id,
    userId: r.user_id,
    title: r.title,
    createdAt: r.created_at,
    readStatus: r.read_status ? ReadStatusValueSchema.parse(r.read_status) : null,
  };
}

export class LocalActivityAdapter implements ActivityStorageAdapter {
  private db: Database | null = null;
  private dbPath: string;

  constructor(dbPath?: string) {
    this.dbPath = dbPath ?? join(getDefaultDbDir(), "activity.db");
  }

  private async getDb(): Promise<Database> {
    if (!this.db) {
      const { Database: SqliteDatabase } = await import("@db/sqlite");
      this.db = new SqliteDatabase(this.dbPath);
      this.db.exec("PRAGMA foreign_keys = ON");
      this.db.exec(SCHEMA);
      logger.info("Database initialized", { dbPath: this.dbPath });
    }
    return this.db;
  }

  async create(input: CreateActivityInput): Promise<Activity> {
    const db = await this.getDb();
    const id = ulid();
    const now = new Date().toISOString();

    db.exec("BEGIN");
    try {
      db.prepare(`
        INSERT INTO activities (id, type, source, reference_id, workspace_id, job_id, user_id, title, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        input.type,
        input.source,
        input.referenceId,
        input.workspaceId,
        input.jobId,
        input.userId,
        input.title,
        now,
      );

      // Auto-insert viewed status for user-initiated activities
      if (input.source === "user" && input.userId) {
        db.prepare(`
          INSERT INTO activity_read_status (user_id, activity_id, status)
          VALUES (?, ?, 'viewed')
        `).run(input.userId, id);
      }

      db.exec("COMMIT");
      logger.debug("Activity created", {
        id,
        type: input.type,
        source: input.source,
        workspaceId: input.workspaceId,
      });
    } catch (e) {
      db.exec("ROLLBACK");
      logger.error("Failed to create activity", { type: input.type, error: String(e) });
      throw e;
    }

    return {
      id,
      type: input.type,
      source: input.source,
      referenceId: input.referenceId,
      workspaceId: input.workspaceId,
      jobId: input.jobId,
      userId: input.userId,
      title: input.title,
      createdAt: now,
    };
  }

  async deleteByReferenceId(referenceId: string): Promise<void> {
    const db = await this.getDb();
    // Manually clean up read_status rows first — existing databases may lack ON DELETE CASCADE
    db.prepare(
      `DELETE FROM activity_read_status WHERE activity_id IN (
        SELECT id FROM activities WHERE reference_id = ?
      )`,
    ).run(referenceId);
    db.prepare("DELETE FROM activities WHERE reference_id = ?").run(referenceId);
    logger.debug("Activities deleted by referenceId", { referenceId });
  }

  async list(userId: string, filters?: ActivityListFilter): Promise<ActivityListResult> {
    const db = await this.getDb();

    let sql = `
      SELECT a.*, ars.status as read_status
      FROM activities a
      LEFT JOIN activity_read_status ars
        ON ars.activity_id = a.id AND ars.user_id = ?
    `;

    const conditions: string[] = [];
    const params: (string | number)[] = [userId];

    if (filters?.type) {
      conditions.push("a.type = ?");
      params.push(filters.type);
    }
    if (filters?.workspaceId) {
      conditions.push("a.workspace_id = ?");
      params.push(filters.workspaceId);
    }
    if (filters?.after) {
      conditions.push("a.created_at > ?");
      params.push(filters.after);
    }
    if (filters?.before) {
      conditions.push("a.created_at < ?");
      params.push(filters.before);
    }

    if (conditions.length > 0) {
      sql += ` WHERE ${conditions.join(" AND ")}`;
    }

    sql += " ORDER BY a.created_at DESC";

    // Fetch limit + 1 to determine hasMore
    const limit = filters?.limit ?? 100;
    sql += " LIMIT ?";
    params.push(limit + 1);

    if (filters?.offset) {
      sql += " OFFSET ?";
      params.push(filters.offset);
    }

    const rows = db.prepare(sql).all(...params);
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit);

    logger.debug("Activities listed", { count: items.length, hasMore, filters });
    return { activities: items.map((row) => rowToActivityWithReadStatus(row)), hasMore };
  }

  async getUnreadCount(userId: string, workspaceId?: string): Promise<number> {
    const db = await this.getDb();

    const sql = workspaceId
      ? `SELECT COUNT(*) as count
         FROM activities a
         WHERE a.workspace_id = ?
           AND NOT EXISTS (
             SELECT 1 FROM activity_read_status ars
             WHERE ars.activity_id = a.id AND ars.user_id = ?
           )`
      : `SELECT COUNT(*) as count
         FROM activities a
         WHERE NOT EXISTS (
           SELECT 1 FROM activity_read_status ars
           WHERE ars.activity_id = a.id AND ars.user_id = ?
         )`;

    const params = workspaceId ? [workspaceId, userId] : [userId];
    const result = db.prepare(sql).get(...params);

    const parsed = countRowSchema.parse(result);
    logger.debug("Unread count queried", { userId, workspaceId, count: parsed.count });
    return parsed.count;
  }

  async updateReadStatus(
    userId: string,
    activityIds: string[],
    status: ReadStatusValue,
  ): Promise<void> {
    if (activityIds.length === 0) return;

    const db = await this.getDb();
    const stmt = db.prepare(`
      INSERT INTO activity_read_status (user_id, activity_id, status)
      VALUES (?, ?, ?)
      ON CONFLICT (user_id, activity_id) DO UPDATE SET status = excluded.status
    `);

    db.exec("BEGIN");
    try {
      for (const activityId of activityIds) {
        stmt.run(userId, activityId, status);
      }
      db.exec("COMMIT");
      logger.debug("Read status updated", { userId, count: activityIds.length, status });
    } catch (e) {
      db.exec("ROLLBACK");
      logger.error("Failed to update read status", { userId, error: String(e) });
      throw e;
    }
  }

  async markViewedBefore(userId: string, before: string, workspaceId?: string): Promise<void> {
    const db = await this.getDb();

    const sql = workspaceId
      ? `INSERT INTO activity_read_status (user_id, activity_id, status)
         SELECT ?, a.id, 'viewed'
         FROM activities a
         WHERE a.created_at < ?
           AND a.workspace_id = ?
           AND NOT EXISTS (
             SELECT 1 FROM activity_read_status ars
             WHERE ars.activity_id = a.id AND ars.user_id = ?
           )`
      : `INSERT INTO activity_read_status (user_id, activity_id, status)
         SELECT ?, a.id, 'viewed'
         FROM activities a
         WHERE a.created_at < ?
           AND NOT EXISTS (
             SELECT 1 FROM activity_read_status ars
             WHERE ars.activity_id = a.id AND ars.user_id = ?
           )`;

    const params = workspaceId ? [userId, before, workspaceId, userId] : [userId, before, userId];
    db.prepare(sql).run(...params);
    logger.debug("Marked activities viewed before timestamp", { userId, before, workspaceId });
  }
}

function getDefaultDbDir(): string {
  return getAtlasHome();
}
