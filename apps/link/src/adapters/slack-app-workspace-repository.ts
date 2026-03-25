import { logger } from "@atlas/logger";
import type { Sql } from "postgres";

/** Maps slack-app credentials to Atlas workspace IDs. Service-level table — no RLS user context needed. */
export interface SlackAppWorkspaceRepository {
  insert(credentialId: string, workspaceId: string): Promise<void>;
  deleteByCredentialId(credentialId: string): Promise<void>;
  findByWorkspaceId(workspaceId: string): Promise<{ credentialId: string } | null>;
  findByCredentialId(credentialId: string): Promise<{ workspaceId: string } | null>;
}

/** No-op implementation for dev mode. */
export class NoOpSlackAppWorkspaceRepository implements SlackAppWorkspaceRepository {
  insert(credentialId: string, workspaceId: string): Promise<void> {
    logger.info("slack_app_workspace_insert_noop", { credentialId, workspaceId });
    return Promise.resolve();
  }

  deleteByCredentialId(credentialId: string): Promise<void> {
    logger.info("slack_app_workspace_delete_noop", { credentialId });
    return Promise.resolve();
  }

  findByWorkspaceId(_workspaceId: string): Promise<{ credentialId: string } | null> {
    return Promise.resolve(null);
  }

  findByCredentialId(_credentialId: string): Promise<{ workspaceId: string } | null> {
    return Promise.resolve(null);
  }
}

/** PostgreSQL-backed implementation. */
export class PostgresSlackAppWorkspaceRepository implements SlackAppWorkspaceRepository {
  constructor(private readonly sql: Sql) {}

  async insert(credentialId: string, workspaceId: string): Promise<void> {
    await this.sql`
      INSERT INTO public.slack_app_workspace (credential_id, workspace_id)
      VALUES (${credentialId}, ${workspaceId})
      ON CONFLICT (credential_id) DO UPDATE SET workspace_id = EXCLUDED.workspace_id
    `;
  }

  async deleteByCredentialId(credentialId: string): Promise<void> {
    await this.sql`
      DELETE FROM public.slack_app_workspace WHERE credential_id = ${credentialId}
    `;
  }

  async findByWorkspaceId(workspaceId: string): Promise<{ credentialId: string } | null> {
    const rows = await this.sql<{ credential_id: string }[]>`
      SELECT credential_id FROM public.slack_app_workspace WHERE workspace_id = ${workspaceId} LIMIT 1
    `;
    const row = rows[0];
    if (!row) return null;
    return { credentialId: row.credential_id };
  }

  async findByCredentialId(credentialId: string): Promise<{ workspaceId: string } | null> {
    const rows = await this.sql<{ workspace_id: string }[]>`
      SELECT workspace_id FROM public.slack_app_workspace WHERE credential_id = ${credentialId} LIMIT 1
    `;
    const row = rows[0];
    if (!row) return null;
    return { workspaceId: row.workspace_id };
  }
}
