/**
 * SQLite-backed communicator wiring repository for Friday Studio dev mode.
 *
 * Postgres path uses RLS via `withUserContext()`. SQLite has no row-level
 * security primitives, so this implementation enforces user isolation by
 * filtering every query by `user_id` in the WHERE clause. The
 * `cross-user isolation` test pins this behaviour — if any query forgets the
 * `user_id` filter, that test fails immediately.
 */

import { randomUUID } from "node:crypto";
import { Database } from "@db/sqlite";
import { z } from "zod";
import type { CommunicatorWiringRepository } from "./communicator-wiring-repository.ts";

const SCHEMA_DDL = `
  CREATE TABLE IF NOT EXISTS communicator_wiring (
    id            TEXT PRIMARY KEY,
    user_id       TEXT NOT NULL,
    credential_id TEXT NOT NULL,
    workspace_id  TEXT NOT NULL,
    provider      TEXT NOT NULL,
    connection_id TEXT NOT NULL,
    created_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_communicator_wiring_workspace_provider
    ON communicator_wiring(user_id, workspace_id, provider);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_communicator_wiring_connection_provider
    ON communicator_wiring(connection_id, provider);
  CREATE INDEX IF NOT EXISTS idx_communicator_wiring_user_id
    ON communicator_wiring(user_id);
`;

const CredentialIdRow = z.object({ credential_id: z.string() });
const WorkspaceIdRow = z.object({ workspace_id: z.string() });
const FindByWorkspaceRow = z.object({ credential_id: z.string(), connection_id: z.string() });
const FindByConnectionRow = z.object({ workspace_id: z.string(), credential_id: z.string() });

export class SqliteCommunicatorWiringRepository implements CommunicatorWiringRepository {
  private readonly db: Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec(SCHEMA_DDL);
  }

  insert(
    userId: string,
    credentialId: string,
    workspaceId: string,
    provider: string,
    identifier: string,
  ): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO communicator_wiring (id, user_id, credential_id, workspace_id, provider, connection_id)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, workspace_id, provider) DO UPDATE SET
           credential_id = excluded.credential_id,
           connection_id = excluded.connection_id`,
      )
      .run(randomUUID(), userId, credentialId, workspaceId, provider, identifier);
    return Promise.resolve();
  }

  deleteByWorkspaceAndProvider(
    userId: string,
    workspaceId: string,
    provider: string,
  ): Promise<{ credentialId: string } | null> {
    const row: unknown = this.db
      .prepare(
        `SELECT credential_id FROM communicator_wiring
         WHERE user_id = ? AND workspace_id = ? AND provider = ?
         LIMIT 1`,
      )
      .get(userId, workspaceId, provider);

    const parsed = CredentialIdRow.safeParse(row);
    if (!parsed.success) return Promise.resolve(null);

    this.db
      .prepare(
        `DELETE FROM communicator_wiring
         WHERE user_id = ? AND workspace_id = ? AND provider = ?`,
      )
      .run(userId, workspaceId, provider);

    return Promise.resolve({ credentialId: parsed.data.credential_id });
  }

  deleteByCredentialId(userId: string, credentialId: string): Promise<void> {
    this.db
      .prepare(`DELETE FROM communicator_wiring WHERE user_id = ? AND credential_id = ?`)
      .run(userId, credentialId);
    return Promise.resolve();
  }

  findByWorkspaceAndProvider(
    userId: string,
    workspaceId: string,
    provider: string,
  ): Promise<{ credentialId: string; identifier: string } | null> {
    const row: unknown = this.db
      .prepare(
        `SELECT credential_id, connection_id FROM communicator_wiring
         WHERE user_id = ? AND workspace_id = ? AND provider = ?
         LIMIT 1`,
      )
      .get(userId, workspaceId, provider);

    const parsed = FindByWorkspaceRow.safeParse(row);
    if (!parsed.success) return Promise.resolve(null);
    return Promise.resolve({
      credentialId: parsed.data.credential_id,
      identifier: parsed.data.connection_id,
    });
  }

  findByCredentialId(
    userId: string,
    credentialId: string,
  ): Promise<{ workspaceId: string } | null> {
    const row: unknown = this.db
      .prepare(
        `SELECT workspace_id FROM communicator_wiring
         WHERE user_id = ? AND credential_id = ?
         LIMIT 1`,
      )
      .get(userId, credentialId);

    const parsed = WorkspaceIdRow.safeParse(row);
    if (!parsed.success) return Promise.resolve(null);
    return Promise.resolve({ workspaceId: parsed.data.workspace_id });
  }

  listWiredWorkspaceIds(userId: string): Promise<string[]> {
    const rows: unknown[] = this.db
      .prepare(`SELECT DISTINCT workspace_id FROM communicator_wiring WHERE user_id = ?`)
      .all(userId);

    const ids: string[] = [];
    for (const row of rows) {
      const parsed = WorkspaceIdRow.safeParse(row);
      if (parsed.success) ids.push(parsed.data.workspace_id);
    }
    return Promise.resolve(ids);
  }

  findByConnectionAndProvider(
    userId: string,
    connectionId: string,
    provider: string,
  ): Promise<{ workspaceId: string; credentialId: string } | null> {
    const row: unknown = this.db
      .prepare(
        `SELECT workspace_id, credential_id FROM communicator_wiring
         WHERE user_id = ? AND connection_id = ? AND provider = ?
         LIMIT 1`,
      )
      .get(userId, connectionId, provider);

    const parsed = FindByConnectionRow.safeParse(row);
    if (!parsed.success) return Promise.resolve(null);
    return Promise.resolve({
      workspaceId: parsed.data.workspace_id,
      credentialId: parsed.data.credential_id,
    });
  }

  /** Closes the SQLite connection. Used in tests; not called in production. */
  close(): void {
    this.db.close();
  }
}
