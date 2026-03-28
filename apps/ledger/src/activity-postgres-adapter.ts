import type {
  Activity,
  ActivityListFilter,
  ActivityListResult,
  ActivityStorageAdapter,
  ActivityWithReadStatus,
  CreateActivityInput,
  ReadStatusValue,
} from "@atlas/activity";
import { ActivitySourceSchema, ActivityTypeSchema, ReadStatusValueSchema } from "@atlas/activity";
import { createLogger } from "@atlas/logger";
import type { Sql } from "postgres";
import { withUserContext } from "./rls.ts";

const logger = createLogger({ component: "activity-postgres-adapter" });

/** Raw row from the activities table (snake_case). */
interface ActivityRow {
  id: string;
  type: string;
  source: string;
  reference_id: string;
  workspace_id: string;
  job_id: string | null;
  user_id: string;
  title: string;
  created_at: Date;
}

/** Raw row from list query with LEFT JOIN on read status. */
interface ActivityWithReadStatusRow extends ActivityRow {
  read_status: string | null;
}

function toActivity(row: ActivityRow): Activity {
  return {
    id: row.id,
    type: ActivityTypeSchema.parse(row.type),
    source: ActivitySourceSchema.parse(row.source),
    referenceId: row.reference_id,
    workspaceId: row.workspace_id,
    jobId: row.job_id,
    userId: row.user_id,
    title: row.title,
    createdAt: row.created_at.toISOString(),
  };
}

function toActivityWithReadStatus(row: ActivityWithReadStatusRow): ActivityWithReadStatus {
  return {
    id: row.id,
    type: ActivityTypeSchema.parse(row.type),
    source: ActivitySourceSchema.parse(row.source),
    referenceId: row.reference_id,
    workspaceId: row.workspace_id,
    jobId: row.job_id,
    userId: row.user_id,
    title: row.title,
    createdAt: row.created_at.toISOString(),
    readStatus: row.read_status ? ReadStatusValueSchema.parse(row.read_status) : null,
  };
}

/**
 * Postgres implementation of ActivityStorageAdapter.
 * Uses RLS via withUserContext() for user-level isolation.
 */
export class ActivityPostgresAdapter implements ActivityStorageAdapter {
  constructor(
    readonly sql: Sql,
    private userId: string,
  ) {}

  create(input: CreateActivityInput): Promise<Activity> {
    return withUserContext(this.sql, this.userId, async (tx) => {
      const [row] = await tx<ActivityRow[]>`
        INSERT INTO public.activities
          (type, source, reference_id, workspace_id, job_id, user_id, title)
        VALUES
          (${input.type}, ${input.source}, ${input.referenceId}, ${input.workspaceId}, ${input.jobId}, ${this.userId}, ${input.title})
        RETURNING id, type, source, reference_id, workspace_id, job_id, user_id, title, created_at
      `;

      if (!row) {
        throw new Error("Failed to insert activity");
      }

      // Auto-insert viewed status for user-initiated activities
      if (input.source === "user") {
        await tx`
          INSERT INTO public.activity_read_status (user_id, activity_id, status)
          VALUES (${this.userId}, ${row.id}, 'viewed')
        `;
      }

      logger.debug("Activity created", {
        id: row.id,
        type: input.type,
        source: input.source,
        workspaceId: input.workspaceId,
      });

      return toActivity(row);
    });
  }

  async deleteByReferenceId(referenceId: string): Promise<void> {
    await withUserContext(this.sql, this.userId, async (tx) => {
      await tx`
        DELETE FROM public.activities WHERE reference_id = ${referenceId}
      `;
      logger.debug("Activities deleted by referenceId", { referenceId });
    });
  }

  list(userId: string, filters?: ActivityListFilter): Promise<ActivityListResult> {
    return withUserContext(this.sql, this.userId, async (tx) => {
      const limit = filters?.limit ?? 100;
      const offset = filters?.offset ?? 0;
      const fetchLimit = limit + 1;

      const rows = await tx<ActivityWithReadStatusRow[]>`
        SELECT
          a.id, a.type, a.source, a.reference_id, a.workspace_id,
          a.job_id, a.user_id, a.title, a.created_at,
          ars.status as read_status
        FROM public.activities a
        LEFT JOIN public.activity_read_status ars
          ON ars.activity_id = a.id AND ars.user_id = ${userId}
        WHERE TRUE
          ${filters?.type ? tx`AND a.type = ${filters.type}` : tx``}
          ${filters?.workspaceId ? tx`AND a.workspace_id = ${filters.workspaceId}` : tx``}
          ${filters?.after ? tx`AND a.created_at > ${filters.after}` : tx``}
          ${filters?.before ? tx`AND a.created_at < ${filters.before}` : tx``}
        ORDER BY a.created_at DESC
        LIMIT ${fetchLimit}
        OFFSET ${offset}
      `;

      const hasMore = rows.length > limit;
      const items = rows.slice(0, limit);

      logger.debug("Activities listed", { count: items.length, hasMore, filters });
      return { activities: items.map(toActivityWithReadStatus), hasMore };
    });
  }

  getUnreadCount(userId: string, workspaceId?: string): Promise<number> {
    return withUserContext(this.sql, this.userId, async (tx) => {
      const [result] = await tx<{ count: string }[]>`
        SELECT COUNT(*) as count
        FROM public.activities a
        WHERE NOT EXISTS (
          SELECT 1 FROM public.activity_read_status ars
          WHERE ars.activity_id = a.id AND ars.user_id = ${userId}
        )
        ${workspaceId ? tx`AND a.workspace_id = ${workspaceId}` : tx``}
      `;

      const count = Number(result?.count ?? 0);
      logger.debug("Unread count queried", { userId, workspaceId, count });
      return count;
    });
  }

  async updateReadStatus(
    userId: string,
    activityIds: string[],
    status: ReadStatusValue,
  ): Promise<void> {
    if (activityIds.length === 0) return;

    await withUserContext(this.sql, this.userId, async (tx) => {
      for (const activityId of activityIds) {
        await tx`
          INSERT INTO public.activity_read_status (user_id, activity_id, status)
          VALUES (${userId}, ${activityId}, ${status})
          ON CONFLICT (user_id, activity_id) DO UPDATE SET status = EXCLUDED.status
        `;
      }
      logger.debug("Read status updated", { userId, count: activityIds.length, status });
    });
  }

  async markViewedBefore(userId: string, before: string, workspaceId?: string): Promise<void> {
    await withUserContext(this.sql, this.userId, async (tx) => {
      await tx`
        INSERT INTO public.activity_read_status (user_id, activity_id, status)
        SELECT ${userId}, a.id, 'viewed'
        FROM public.activities a
        WHERE a.created_at < ${before}
          ${workspaceId ? tx`AND a.workspace_id = ${workspaceId}` : tx``}
          AND NOT EXISTS (
            SELECT 1 FROM public.activity_read_status ars
            WHERE ars.activity_id = a.id AND ars.user_id = ${userId}
          )
      `;
      logger.debug("Marked activities viewed before timestamp", { userId, before, workspaceId });
    });
  }
}
