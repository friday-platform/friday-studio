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
  user_identifier: string | null;
  display_name: string | null;
  is_default: boolean;
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

    try {
      return await withUserContext(this.sql, userId, async (tx) => {
        const rows = await tx<
          { id: string; is_default: boolean; created_at: Date; updated_at: Date }[]
        >`
          INSERT INTO public.credential (user_id, type, provider, label, user_identifier, encrypted_secret, is_default)
          VALUES (
            ${userId},
            ${input.type},
            ${input.provider},
            ${input.label},
            ${input.userIdentifier ?? null},
            ${encryptedSecret},
            NOT EXISTS (
              SELECT 1 FROM public.credential
              WHERE user_id = ${userId}
                AND provider = ${input.provider}
                AND deleted_at IS NULL
            )
          )
          RETURNING id, is_default, created_at, updated_at
        `;

        const row = rows[0];
        if (!row) {
          throw new Error("Failed to create credential: no row returned");
        }

        return {
          id: row.id,
          isDefault: row.is_default,
          metadata: {
            createdAt: row.created_at.toISOString(),
            updatedAt: row.updated_at.toISOString(),
          },
        };
      });
    } catch (err: unknown) {
      if (isDefaultConstraintViolation(err)) {
        return await this.saveWithoutDefault(input, userId, encryptedSecret);
      }
      throw err;
    }
  }

  /**
   * Retry INSERT with is_default = false after concurrent insert race.
   * The partial unique index caught the race — this credential is still created, just not as default.
   */
  private async saveWithoutDefault(
    input: CredentialInput,
    userId: string,
    encryptedSecret: string,
  ): Promise<SaveResult> {
    return await withUserContext(this.sql, userId, async (tx) => {
      const rows = await tx<
        { id: string; is_default: boolean; created_at: Date; updated_at: Date }[]
      >`
        INSERT INTO public.credential (user_id, type, provider, label, user_identifier, encrypted_secret, is_default)
        VALUES (
          ${userId},
          ${input.type},
          ${input.provider},
          ${input.label},
          ${input.userIdentifier ?? null},
          ${encryptedSecret},
          false
        )
        RETURNING id, is_default, created_at, updated_at
      `;

      const row = rows[0];
      if (!row) {
        throw new Error("Failed to create credential: no row returned");
      }

      return {
        id: row.id,
        isDefault: row.is_default,
        metadata: {
          createdAt: row.created_at.toISOString(),
          updatedAt: row.updated_at.toISOString(),
        },
      };
    });
  }

  async upsert(input: CredentialInput, userId: string): Promise<SaveResult> {
    const encryptedSecret = await this.encryptSecret(input.secret);

    try {
      return await withUserContext(this.sql, userId, async (tx) => {
        const rows = await tx<
          { id: string; is_default: boolean; created_at: Date; updated_at: Date }[]
        >`
          INSERT INTO public.credential (user_id, type, provider, label, user_identifier, encrypted_secret, is_default)
          VALUES (
            ${userId},
            ${input.type},
            ${input.provider},
            ${input.label},
            ${input.userIdentifier ?? null},
            ${encryptedSecret},
            NOT EXISTS (
              SELECT 1 FROM public.credential
              WHERE user_id = ${userId}
                AND provider = ${input.provider}
                AND deleted_at IS NULL
            )
          )
          ON CONFLICT (user_id, provider, label) WHERE deleted_at IS NULL
          DO UPDATE SET
            encrypted_secret = EXCLUDED.encrypted_secret,
            user_identifier = EXCLUDED.user_identifier,
            is_default = CASE
              WHEN NOT public.credential.is_default AND NOT EXISTS (
                SELECT 1 FROM public.credential c2
                WHERE c2.user_id = ${userId}
                  AND c2.provider = ${input.provider}
                  AND c2.is_default = true
                  AND c2.deleted_at IS NULL
                  AND c2.id != public.credential.id
              )
              THEN true
              ELSE public.credential.is_default
            END
          RETURNING id, is_default, created_at, updated_at
        `;

        const row = rows[0];
        if (!row) throw new Error("Upsert failed: no row returned");

        return {
          id: row.id,
          isDefault: row.is_default,
          metadata: {
            createdAt: row.created_at.toISOString(),
            updatedAt: row.updated_at.toISOString(),
          },
        };
      });
    } catch (err: unknown) {
      if (isDefaultConstraintViolation(err)) {
        return await this.upsertWithoutDefault(input, userId, encryptedSecret);
      }
      throw err;
    }
  }

  /**
   * Retry upsert with is_default = false after concurrent insert race.
   * The partial unique index caught the race — this credential is still created/updated, just not as default.
   */
  private async upsertWithoutDefault(
    input: CredentialInput,
    userId: string,
    encryptedSecret: string,
  ): Promise<SaveResult> {
    return await withUserContext(this.sql, userId, async (tx) => {
      const rows = await tx<
        { id: string; is_default: boolean; created_at: Date; updated_at: Date }[]
      >`
        INSERT INTO public.credential (user_id, type, provider, label, user_identifier, encrypted_secret, is_default)
        VALUES (
          ${userId},
          ${input.type},
          ${input.provider},
          ${input.label},
          ${input.userIdentifier ?? null},
          ${encryptedSecret},
          false
        )
        ON CONFLICT (user_id, provider, label) WHERE deleted_at IS NULL
        DO UPDATE SET
          encrypted_secret = EXCLUDED.encrypted_secret,
          user_identifier = EXCLUDED.user_identifier,
          is_default = public.credential.is_default
        RETURNING id, is_default, created_at, updated_at
      `;

      const row = rows[0];
      if (!row) throw new Error("Upsert failed: no row returned");

      return {
        id: row.id,
        isDefault: row.is_default,
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
          user_identifier = ${input.userIdentifier ?? null},
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
        SELECT id, user_id, type, provider, label, user_identifier, display_name, is_default, encrypted_secret, created_at, updated_at
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
        userIdentifier: row.user_identifier ?? undefined,
        displayName: row.display_name ?? undefined,
        isDefault: row.is_default,
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
        SELECT id, type, provider, label, user_identifier, display_name, is_default, created_at, updated_at
        FROM public.credential
        WHERE user_id = ${userId} AND type = ${type} AND deleted_at IS NULL
      `;

      // No decryption - list returns summaries without secrets
      return rows.map((row) => ({
        id: row.id,
        type: CredentialTypeSchema.parse(row.type),
        provider: row.provider,
        label: row.label,
        userIdentifier: row.user_identifier ?? undefined,
        displayName: row.display_name ?? undefined,
        isDefault: row.is_default,
        metadata: {
          createdAt: row.created_at.toISOString(),
          updatedAt: row.updated_at.toISOString(),
        },
      }));
    });
  }

  async delete(id: string, userId: string): Promise<void> {
    await withUserContext(this.sql, userId, async (tx) => {
      // Soft-delete and capture whether the credential was the default
      const deleted = await tx<{ provider: string; is_default: boolean }[]>`
        UPDATE public.credential
        SET deleted_at = now()
        WHERE id = ${id} AND user_id = ${userId} AND deleted_at IS NULL
        RETURNING provider, is_default
      `;

      const row = deleted[0];
      if (!row?.is_default) return;

      // Promote the next-oldest active credential for the same provider
      await tx`
        UPDATE public.credential SET is_default = true
        WHERE id = (
          SELECT id FROM public.credential
          WHERE user_id = ${userId}
            AND provider = ${row.provider}
            AND deleted_at IS NULL
          ORDER BY created_at ASC, id ASC LIMIT 1
        ) AND deleted_at IS NULL
      `;
    });
  }

  async updateMetadata(
    id: string,
    metadata: { displayName?: string },
    userId: string,
  ): Promise<Metadata> {
    return await withUserContext(this.sql, userId, async (tx) => {
      const rows = await tx<{ created_at: Date; updated_at: Date }[]>`
        UPDATE public.credential
        SET display_name = ${metadata.displayName ?? null}
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

  setDefault(id: string, userId: string): Promise<void> {
    return this.setDefaultWithRetry(id, userId, false);
  }

  private async setDefaultWithRetry(id: string, userId: string, retried: boolean): Promise<void> {
    try {
      await withUserContext(this.sql, userId, async (tx) => {
        const rows = await tx<{ id: string; provider: string; is_default: boolean }[]>`
          SELECT id, provider, is_default
          FROM public.credential
          WHERE id = ${id} AND user_id = ${userId} AND deleted_at IS NULL
        `;

        const row = rows[0];
        if (!row) {
          throw new Error("Credential not found");
        }

        if (row.is_default) {
          return;
        }

        await tx`
          UPDATE public.credential
          SET is_default = false
          WHERE user_id = ${userId}
            AND provider = ${row.provider}
            AND is_default = true
            AND deleted_at IS NULL
        `;

        await tx`
          UPDATE public.credential
          SET is_default = true
          WHERE id = ${id}
            AND user_id = ${userId}
            AND deleted_at IS NULL
        `;
      });
    } catch (err: unknown) {
      if (isDefaultConstraintViolation(err) && !retried) {
        // Concurrent swap race — retry once
        await this.setDefaultWithRetry(id, userId, true);
        return;
      }
      throw err;
    }
  }

  async getDefaultByProvider(provider: string, userId: string): Promise<Credential | null> {
    return await withUserContext(this.sql, userId, async (tx) => {
      const rows = await tx<CredentialRow[]>`
        SELECT id, user_id, type, provider, label, user_identifier, display_name, is_default, encrypted_secret, created_at, updated_at
        FROM public.credential
        WHERE user_id = ${userId}
          AND provider = ${provider}
          AND is_default = true
          AND deleted_at IS NULL
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
        userIdentifier: row.user_identifier ?? undefined,
        displayName: row.display_name ?? undefined,
        isDefault: row.is_default,
        secret,
        metadata: {
          createdAt: row.created_at.toISOString(),
          updatedAt: row.updated_at.toISOString(),
        },
      };
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
        SELECT id, user_id, type, provider, label, user_identifier, display_name, is_default, encrypted_secret, created_at, updated_at
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
            userIdentifier: row.user_identifier ?? undefined,
            displayName: row.display_name ?? undefined,
            isDefault: row.is_default,
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

/**
 * Checks if an error is a unique constraint violation on the default credential index.
 * postgres.js surfaces the constraint name as `constraint_name` on the error object.
 */
function isDefaultConstraintViolation(err: unknown): boolean {
  return (
    err instanceof Error &&
    "constraint_name" in err &&
    (err as Error & { constraint_name: string }).constraint_name ===
      "idx_credential_default_per_provider"
  );
}
