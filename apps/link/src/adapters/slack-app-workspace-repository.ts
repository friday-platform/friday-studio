import { logger } from "@atlas/logger";
import type { Sql } from "postgres";
import { withUserContext } from "./rls.ts";

/**
 * Maps slack-app credentials to Atlas workspace IDs.
 *
 * RLS-protected: every query runs inside `withUserContext()` so policies on
 * `public.slack_app_workspace` filter rows to the caller's user_id. Callers
 * must pass the authenticated user's ID on every method.
 */
export interface SlackAppWorkspaceRepository {
  insert(credentialId: string, workspaceId: string, userId: string): Promise<void>;
  deleteByCredentialId(credentialId: string, userId: string): Promise<void>;
  findByWorkspaceId(workspaceId: string, userId: string): Promise<{ credentialId: string } | null>;
  findByCredentialId(credentialId: string, userId: string): Promise<{ workspaceId: string } | null>;
}

/** No-op implementation for dev mode. */
export class NoOpSlackAppWorkspaceRepository implements SlackAppWorkspaceRepository {
  insert(credentialId: string, workspaceId: string, userId: string): Promise<void> {
    logger.info("slack_app_workspace_insert_noop", { credentialId, workspaceId, userId });
    return Promise.resolve();
  }

  deleteByCredentialId(credentialId: string, userId: string): Promise<void> {
    logger.info("slack_app_workspace_delete_noop", { credentialId, userId });
    return Promise.resolve();
  }

  findByWorkspaceId(
    _workspaceId: string,
    _userId: string,
  ): Promise<{ credentialId: string } | null> {
    return Promise.resolve(null);
  }

  findByCredentialId(
    _credentialId: string,
    _userId: string,
  ): Promise<{ workspaceId: string } | null> {
    return Promise.resolve(null);
  }
}

/**
 * PostgreSQL-backed implementation.
 *
 * Every method runs inside `withUserContext()`, which sets `SET LOCAL ROLE
 * authenticated` and `request.user_id`. RLS policies on the table then
 * restrict every statement to rows where `user_id = request.user_id`, so
 * the adapter cannot accidentally touch another user's rows even with a
 * `WHERE workspace_id = $1`-style filter.
 */
export class PostgresSlackAppWorkspaceRepository implements SlackAppWorkspaceRepository {
  constructor(private readonly sql: Sql) {}

  async insert(credentialId: string, workspaceId: string, userId: string): Promise<void> {
    await withUserContext(this.sql, userId, async (tx) => {
      // Handles "rewire workspace W from credential A to credential B".
      // Postgres only honors one ON CONFLICT target per INSERT, and the
      // INSERT below targets credential_id. Without this DELETE, the INSERT
      // would fail the (user_id, workspace_id) unique constraint when a
      // different credential was previously wired to the same workspace.
      // Safe under RLS — only touches the caller's own rows.
      await tx`DELETE FROM public.slack_app_workspace WHERE workspace_id = ${workspaceId}`;
      // Handles "rewire credential C from workspace A to workspace B".
      await tx`
        INSERT INTO public.slack_app_workspace (credential_id, workspace_id, user_id)
        VALUES (${credentialId}, ${workspaceId}, ${userId})
        ON CONFLICT (credential_id) DO UPDATE SET workspace_id = EXCLUDED.workspace_id
      `;
    });
  }

  async deleteByCredentialId(credentialId: string, userId: string): Promise<void> {
    await withUserContext(
      this.sql,
      userId,
      (tx) => tx`DELETE FROM public.slack_app_workspace WHERE credential_id = ${credentialId}`,
    );
  }

  findByWorkspaceId(workspaceId: string, userId: string): Promise<{ credentialId: string } | null> {
    return withUserContext(this.sql, userId, async (tx) => {
      const rows = await tx<{ credential_id: string }[]>`
        SELECT credential_id FROM public.slack_app_workspace
        WHERE workspace_id = ${workspaceId}
        LIMIT 1
      `;
      const row = rows[0];
      if (!row) return null;
      return { credentialId: row.credential_id };
    });
  }

  findByCredentialId(
    credentialId: string,
    userId: string,
  ): Promise<{ workspaceId: string } | null> {
    return withUserContext(this.sql, userId, async (tx) => {
      const rows = await tx<{ workspace_id: string }[]>`
        SELECT workspace_id FROM public.slack_app_workspace
        WHERE credential_id = ${credentialId}
        LIMIT 1
      `;
      const row = rows[0];
      if (!row) return null;
      return { workspaceId: row.workspace_id };
    });
  }
}
