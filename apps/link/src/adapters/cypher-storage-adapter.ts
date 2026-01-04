import type { Sql } from "postgres";
import { z } from "zod";
import type { CypherClient } from "../cypher-client.ts";
import {
  type Credential,
  type CredentialInput,
  type CredentialSummary,
  CredentialTypeSchema,
  type Metadata,
  type SaveResult,
  type StorageAdapter,
} from "../types.ts";
import { withUserContext } from "./rls.ts";

/** Schema for validating decrypted secret JSON */
const SecretSchema = z.record(z.string(), z.unknown());

/**
 * Database row type for the link.credential table.
 */
interface CredentialRow {
  id: string;
  user_id: string;
  type: string;
  provider: string;
  label: string;
  encrypted_secret: string;
  created_at: Date;
  updated_at: Date;
}

/**
 * PostgreSQL-backed storage adapter with Cypher encryption for secrets.
 *
 * This adapter:
 * - Encrypts credential secrets before storing in PostgreSQL
 * - Decrypts secrets on retrieval
 * - Uses public.credential table
 * - Scopes all operations to the authenticated user
 *
 * Requires:
 * - Cypher service running (for encryption/decryption)
 * - PostgreSQL with public.credential table
 */
export class CypherStorageAdapter implements StorageAdapter {
  constructor(
    private readonly cypher: CypherClient,
    private readonly sql: Sql,
  ) {}

  /** Encrypt a secret object and return the ciphertext string. */
  private async encryptSecret(secret: Record<string, unknown>): Promise<string> {
    const encrypted = await this.cypher.encrypt([JSON.stringify(secret)]);
    const ciphertext = encrypted[0];
    if (ciphertext === undefined) {
      throw new Error("Failed to encrypt credential: empty response");
    }
    return ciphertext;
  }

  async save(input: CredentialInput, userId: string): Promise<SaveResult> {
    const encryptedSecret = await this.encryptSecret(input.secret);

    return await withUserContext(this.sql, userId, async (tx) => {
      const rows = await tx<{ id: string; created_at: Date; updated_at: Date }[]>`
        INSERT INTO public.credential (user_id, type, provider, label, encrypted_secret)
        VALUES (
          ${userId},
          ${input.type},
          ${input.provider},
          ${input.label},
          ${encryptedSecret}
        )
        RETURNING id, created_at, updated_at
      `;

      const row = rows[0];
      if (!row) {
        throw new Error("Failed to create credential: no row returned");
      }

      return {
        id: row.id,
        metadata: {
          createdAt: row.created_at.toISOString(),
          updatedAt: row.updated_at.toISOString(),
        },
      };
    });
  }

  async upsert(input: CredentialInput, userId: string): Promise<SaveResult> {
    const encryptedSecret = await this.encryptSecret(input.secret);

    return await withUserContext(this.sql, userId, async (tx) => {
      const rows = await tx<{ id: string; created_at: Date; updated_at: Date }[]>`
        INSERT INTO public.credential (user_id, type, provider, label, encrypted_secret)
        VALUES (
          ${userId},
          ${input.type},
          ${input.provider},
          ${input.label},
          ${encryptedSecret}
        )
        ON CONFLICT (user_id, provider, label) WHERE deleted_at IS NULL
        DO UPDATE SET
          encrypted_secret = EXCLUDED.encrypted_secret
        RETURNING id, created_at, updated_at
      `;

      const row = rows[0];
      if (!row) throw new Error("Upsert failed: no row returned");

      return {
        id: row.id,
        metadata: {
          createdAt: row.created_at.toISOString(),
          updatedAt: row.updated_at.toISOString(),
        },
      };
    });
  }

  async update(id: string, input: CredentialInput, userId: string): Promise<Metadata> {
    const encryptedSecret = await this.encryptSecret(input.secret);

    return await withUserContext(this.sql, userId, async (tx) => {
      const rows = await tx<{ created_at: Date; updated_at: Date }[]>`
        UPDATE public.credential
        SET
          type = ${input.type},
          provider = ${input.provider},
          label = ${input.label},
          encrypted_secret = ${encryptedSecret}
        WHERE id = ${id} AND user_id = ${userId} AND deleted_at IS NULL
        RETURNING created_at, updated_at
      `;

      const row = rows[0];
      if (!row) {
        throw new Error("Credential not found");
      }

      return { createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString() };
    });
  }

  async get(id: string, userId: string): Promise<Credential | null> {
    return await withUserContext(this.sql, userId, async (tx) => {
      const rows = await tx<CredentialRow[]>`
        SELECT id, user_id, type, provider, label, encrypted_secret, created_at, updated_at
        FROM public.credential
        WHERE id = ${id} AND user_id = ${userId} AND deleted_at IS NULL
      `;

      const row = rows[0];
      if (!row) {
        return null;
      }

      // Decrypt the secret
      const decrypted = await this.cypher.decrypt([row.encrypted_secret]);
      const secretJson = decrypted[0];
      if (secretJson === undefined) {
        throw new Error("Failed to decrypt credential: empty response");
      }

      // Parse and validate decrypted JSON
      let parsed: unknown;
      try {
        parsed = JSON.parse(secretJson);
      } catch {
        throw new Error("Failed to parse decrypted credential: invalid JSON");
      }
      const secret = SecretSchema.parse(parsed);

      return {
        id: row.id,
        type: CredentialTypeSchema.parse(row.type),
        provider: row.provider,
        label: row.label,
        secret,
        metadata: {
          createdAt: row.created_at.toISOString(),
          updatedAt: row.updated_at.toISOString(),
        },
      };
    });
  }

  async list(type: string, userId: string): Promise<CredentialSummary[]> {
    return await withUserContext(this.sql, userId, async (tx) => {
      const rows = await tx<CredentialRow[]>`
        SELECT id, type, provider, label, created_at, updated_at
        FROM public.credential
        WHERE user_id = ${userId} AND type = ${type} AND deleted_at IS NULL
      `;

      // No decryption - list returns summaries without secrets
      return rows.map((row) => ({
        id: row.id,
        type: CredentialTypeSchema.parse(row.type),
        provider: row.provider,
        label: row.label,
        metadata: {
          createdAt: row.created_at.toISOString(),
          updatedAt: row.updated_at.toISOString(),
        },
      }));
    });
  }

  async delete(id: string, userId: string): Promise<void> {
    await withUserContext(this.sql, userId, async (tx) => {
      await tx`
        UPDATE public.credential
        SET deleted_at = now()
        WHERE id = ${id} AND user_id = ${userId} AND deleted_at IS NULL
      `;
    });
  }

  async findByProviderAndExternalId(
    provider: string,
    externalId: string,
    userId: string,
  ): Promise<Credential | null> {
    return await withUserContext(this.sql, userId, async (tx) => {
      // Get all credentials for this user + provider
      const rows = await tx<CredentialRow[]>`
        SELECT id, user_id, type, provider, label, encrypted_secret, created_at, updated_at
        FROM public.credential
        WHERE user_id = ${userId} AND provider = ${provider} AND deleted_at IS NULL
      `;

      // Decrypt and check each for matching externalId
      for (const row of rows) {
        const decrypted = await this.cypher.decrypt([row.encrypted_secret]);
        const secretJson = decrypted[0];
        if (secretJson === undefined) continue;

        let parsed: unknown;
        try {
          parsed = JSON.parse(secretJson);
        } catch {
          continue;
        }

        const secret = SecretSchema.parse(parsed);
        if (typeof secret.externalId === "string" && secret.externalId === externalId) {
          return {
            id: row.id,
            type: CredentialTypeSchema.parse(row.type),
            provider: row.provider,
            label: row.label,
            secret,
            metadata: {
              createdAt: row.created_at.toISOString(),
              updatedAt: row.updated_at.toISOString(),
            },
          };
        }
      }

      return null;
    });
  }
}
