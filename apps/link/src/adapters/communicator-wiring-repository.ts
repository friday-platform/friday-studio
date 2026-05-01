/**
 * Generic communicator wiring repository.
 *
 * Maps credentials to workspaces for any communicator provider (Slack,
 * external-chat, Telegram, etc.). All methods are RLS-protected via
 * `withUserContext()`.
 *
 * The DB column is `connection_id` but the TypeScript interface uses
 * `identifier` — a provider-neutral routing key (external-chat UUID,
 * Slack credential ID, etc.).
 */

import { logger } from "@atlas/logger";
import type { Sql } from "postgres";
import { withUserContext } from "./rls.ts";

export interface CommunicatorWiringRepository {
  /**
   * Wire a credential to a workspace. If the workspace already has a wiring
   * for this provider, the old row is replaced (handles "rewire" scenarios).
   */
  insert(
    userId: string,
    credentialId: string,
    workspaceId: string,
    provider: string,
    identifier: string,
  ): Promise<void>;

  deleteByWorkspaceAndProvider(
    userId: string,
    workspaceId: string,
    provider: string,
  ): Promise<{ credentialId: string } | null>;

  deleteByCredentialId(userId: string, credentialId: string): Promise<void>;

  findByWorkspaceAndProvider(
    userId: string,
    workspaceId: string,
    provider: string,
  ): Promise<{ credentialId: string; identifier: string } | null>;

  findByCredentialId(userId: string, credentialId: string): Promise<{ workspaceId: string } | null>;

  // TODO(stage-3): used by external-chat / signal-gateway. Verbatim from main 05f0157b1; do not modify until stage 3.
  listWiredWorkspaceIds(userId: string): Promise<string[]>;

  // TODO(stage-3): used by external-chat / signal-gateway. Verbatim from main 05f0157b1; do not modify until stage 3.
  findByConnectionAndProvider(
    userId: string,
    connectionId: string,
    provider: string,
  ): Promise<{ workspaceId: string; credentialId: string } | null>;
}

export class NoOpCommunicatorWiringRepository implements CommunicatorWiringRepository {
  insert(
    userId: string,
    _credentialId: string,
    workspaceId: string,
    provider: string,
  ): Promise<void> {
    logger.info("communicator_wiring_insert_noop", { userId, workspaceId, provider });
    return Promise.resolve();
  }

  deleteByWorkspaceAndProvider(
    _userId: string,
    _workspaceId: string,
    _provider: string,
  ): Promise<{ credentialId: string } | null> {
    return Promise.resolve(null);
  }

  deleteByCredentialId(_userId: string, _credentialId: string): Promise<void> {
    return Promise.resolve();
  }

  findByWorkspaceAndProvider(
    _userId: string,
    _workspaceId: string,
    _provider: string,
  ): Promise<{ credentialId: string; identifier: string } | null> {
    return Promise.resolve(null);
  }

  findByCredentialId(
    _userId: string,
    _credentialId: string,
  ): Promise<{ workspaceId: string } | null> {
    return Promise.resolve(null);
  }

  // TODO(stage-3): used by external-chat / signal-gateway. Verbatim from main 05f0157b1; do not modify until stage 3.
  listWiredWorkspaceIds(_userId: string): Promise<string[]> {
    return Promise.resolve([]);
  }

  // TODO(stage-3): used by external-chat / signal-gateway. Verbatim from main 05f0157b1; do not modify until stage 3.
  findByConnectionAndProvider(
    _userId: string,
    _connectionId: string,
    _provider: string,
  ): Promise<{ workspaceId: string; credentialId: string } | null> {
    return Promise.resolve(null);
  }
}

export class PostgresCommunicatorWiringRepository implements CommunicatorWiringRepository {
  constructor(private readonly sql: Sql) {}

  async insert(
    userId: string,
    credentialId: string,
    workspaceId: string,
    provider: string,
    identifier: string,
  ): Promise<void> {
    // Upsert on the (user_id, workspace_id, provider) unique index.
    // Conflict key includes user_id, so cross-user collisions are impossible
    // under RLS — DO UPDATE only ever rewrites the current user's own row.
    await withUserContext(this.sql, userId, async (tx) => {
      await tx`
        INSERT INTO public.communicator_wiring
          (user_id, credential_id, workspace_id, provider, connection_id)
        VALUES
          (${userId}, ${credentialId}, ${workspaceId}, ${provider}, ${identifier})
        ON CONFLICT (user_id, workspace_id, provider) DO UPDATE
        SET credential_id = EXCLUDED.credential_id,
            connection_id = EXCLUDED.connection_id
      `;
    });
  }

  deleteByWorkspaceAndProvider(
    userId: string,
    workspaceId: string,
    provider: string,
  ): Promise<{ credentialId: string } | null> {
    return withUserContext(this.sql, userId, async (tx) => {
      const rows = await tx<{ credential_id: string }[]>`
        DELETE FROM public.communicator_wiring
        WHERE workspace_id = ${workspaceId} AND provider = ${provider}
        RETURNING credential_id
      `;
      const row = rows[0];
      return row ? { credentialId: row.credential_id } : null;
    });
  }

  async deleteByCredentialId(userId: string, credentialId: string): Promise<void> {
    await withUserContext(
      this.sql,
      userId,
      (tx) => tx`DELETE FROM public.communicator_wiring WHERE credential_id = ${credentialId}`,
    );
  }

  findByWorkspaceAndProvider(
    userId: string,
    workspaceId: string,
    provider: string,
  ): Promise<{ credentialId: string; identifier: string } | null> {
    return withUserContext(this.sql, userId, async (tx) => {
      const rows = await tx<{ credential_id: string; connection_id: string }[]>`
        SELECT credential_id, connection_id
        FROM public.communicator_wiring
        WHERE workspace_id = ${workspaceId} AND provider = ${provider}
        LIMIT 1
      `;
      const row = rows[0];
      return row ? { credentialId: row.credential_id, identifier: row.connection_id } : null;
    });
  }

  findByCredentialId(
    userId: string,
    credentialId: string,
  ): Promise<{ workspaceId: string } | null> {
    return withUserContext(this.sql, userId, async (tx) => {
      const rows = await tx<{ workspace_id: string }[]>`
        SELECT workspace_id
        FROM public.communicator_wiring
        WHERE credential_id = ${credentialId}
        LIMIT 1
      `;
      const row = rows[0];
      return row ? { workspaceId: row.workspace_id } : null;
    });
  }

  // TODO(stage-3): used by external-chat / signal-gateway. Verbatim from main 05f0157b1; do not modify until stage 3.
  async listWiredWorkspaceIds(userId: string): Promise<string[]> {
    const rows = await withUserContext(
      this.sql,
      userId,
      (tx) =>
        tx<{ workspace_id: string }[]>`
          SELECT DISTINCT workspace_id FROM public.communicator_wiring
        `,
    );
    return rows.map((r) => r.workspace_id);
  }

  // TODO(stage-3): used by external-chat / signal-gateway. Verbatim from main 05f0157b1; do not modify until stage 3.
  findByConnectionAndProvider(
    userId: string,
    connectionId: string,
    provider: string,
  ): Promise<{ workspaceId: string; credentialId: string } | null> {
    return withUserContext(this.sql, userId, async (tx) => {
      const rows = await tx<{ workspace_id: string; credential_id: string }[]>`
        SELECT workspace_id, credential_id
        FROM public.communicator_wiring
        WHERE connection_id = ${connectionId} AND provider = ${provider}
        LIMIT 1
      `;
      const row = rows[0];
      return row ? { workspaceId: row.workspace_id, credentialId: row.credential_id } : null;
    });
  }
}
