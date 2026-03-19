import type { Sql } from "postgres";
import { describe, expect, it } from "vitest";
import type { CypherClient } from "../cypher-client.ts";
import type { CredentialInput } from "../types.ts";
import { CypherStorageAdapter } from "./cypher-storage-adapter.ts";

/**
 * Creates a mock CypherClient for testing.
 */
function createMockCypher(overrides?: Partial<CypherClient>): CypherClient {
  return {
    encrypt: (plaintext: string[]) => Promise.resolve(plaintext.map((p) => `encrypted:${p}`)),
    decrypt: (ciphertext: string[]) =>
      Promise.resolve(ciphertext.map((c) => c.replace("encrypted:", ""))),
    ...overrides,
  };
}

/**
 * Creates a mock SQL template tag function for testing.
 * Now includes a `begin` method to support RLS transaction wrapper.
 *
 * @param options.queryResult - Result to return from queries
 * @param options.throwError - Error to throw from queries
 * @param options.trackCalls - Array to capture SQL calls (query + values)
 */
function createMockSql(options?: {
  queryResult?: unknown[];
  throwError?: Error;
  trackCalls?: { query: string; values: unknown[] }[];
}): Sql {
  const handler = (strings: TemplateStringsArray, ...values: unknown[]) => {
    options?.trackCalls?.push({ query: strings.join("?"), values });
    if (options?.throwError) {
      return Promise.reject(options.throwError);
    }
    return Promise.resolve(options?.queryResult ?? []);
  };

  const mockSql = handler as Sql;

  // Add begin method for transaction support (used by withUserContext)
  // @ts-expect-error - Mock doesn't need to match full postgres.js begin signature
  mockSql.begin = <T>(callback: (tx: Sql) => Promise<T>): Promise<T> => {
    return callback(handler as Sql);
  };

  return mockSql;
}

/**
 * Creates a mock SQL that returns different results per query call.
 * Each call to the template tag consumes the next result from the queue.
 *
 * @param queryResults - Array of results, one per SQL call (including RLS setup calls)
 * @param trackCalls - Optional array to capture SQL calls
 */
function createSequentialMockSql(
  queryResults: Array<{ result?: unknown[]; error?: Error }>,
  trackCalls?: { query: string; values: unknown[] }[],
): Sql {
  let callIndex = 0;

  const handler = (strings: TemplateStringsArray, ...values: unknown[]) => {
    trackCalls?.push({ query: strings.join("?"), values });
    const entry = queryResults[callIndex++];
    if (entry?.error) {
      return Promise.reject(entry.error);
    }
    return Promise.resolve(entry?.result ?? []);
  };

  const mockSql = handler as Sql;

  // @ts-expect-error - Mock doesn't need to match full postgres.js begin signature
  mockSql.begin = <T>(callback: (tx: Sql) => Promise<T>): Promise<T> => {
    return callback(handler as Sql);
  };

  return mockSql;
}

describe("CypherStorageAdapter", () => {
  const testCredentialInput: CredentialInput = {
    type: "apikey",
    provider: "openai",
    label: "My API Key",
    secret: { key: "sk-test-key" },
  };

  const testOAuthCredentialInput: CredentialInput = {
    type: "oauth",
    provider: "google",
    label: "test@example.com",
    userIdentifier: "test@example.com",
    secret: { access_token: "ya29.test", refresh_token: "1//test" },
  };

  it("save: encrypts secret before storing and returns ID", async () => {
    const encryptCalls: string[][] = [];
    const mockCypher = createMockCypher({
      encrypt: (plaintext) => {
        encryptCalls.push(plaintext);
        return Promise.resolve(plaintext.map((p) => `enc:${p}`));
      },
    });

    const sqlCalls: { query: string; values: unknown[] }[] = [];
    const mockSql = createMockSql({
      queryResult: [
        {
          id: "pg-generated-id",
          is_default: false,
          created_at: new Date("2024-01-01T00:00:00Z"),
          updated_at: new Date("2024-01-01T00:00:00Z"),
        },
      ],
      trackCalls: sqlCalls,
    });

    const adapter = new CypherStorageAdapter(mockCypher, mockSql);
    const result = await adapter.save(testCredentialInput, "user-123");

    // Verify returned SaveResult
    expect(result).toMatchObject({
      id: "pg-generated-id",
      isDefault: false,
      metadata: { createdAt: "2024-01-01T00:00:00.000Z", updatedAt: "2024-01-01T00:00:00.000Z" },
    });

    // Verify encrypt was called with JSON-serialized secret
    expect(encryptCalls).toHaveLength(1);
    expect(encryptCalls[0]).toEqual(['{"key":"sk-test-key"}']);

    // Verify SQL was called with encrypted secret (no id passed - Postgres generates it)
    // Note: 3 calls now - first is SET LOCAL ROLE, second is SET_CONFIG for RLS, third is the INSERT
    expect(sqlCalls).toHaveLength(3);
    const values = sqlCalls[2]?.values ?? []; // Get values from the INSERT query (third call)
    expect(values[0]).toEqual("user-123"); // user_id
    expect(values[1]).toEqual("apikey"); // type
    expect(values[2]).toEqual("openai"); // provider
    expect(values[3]).toEqual("My API Key"); // label
    expect(values[4]).toBeNull(); // user_identifier (null for apikey)
    expect(values[5]).toEqual('enc:{"key":"sk-test-key"}'); // encrypted_secret
  });

  it("save: persists userIdentifier for OAuth credentials", async () => {
    const sqlCalls: { query: string; values: unknown[] }[] = [];
    const mockSql = createMockSql({
      queryResult: [
        {
          id: "oauth-cred-id",
          is_default: false,
          created_at: new Date("2024-01-01T00:00:00Z"),
          updated_at: new Date("2024-01-01T00:00:00Z"),
        },
      ],
      trackCalls: sqlCalls,
    });

    const adapter = new CypherStorageAdapter(createMockCypher(), mockSql);
    const result = await adapter.save(testOAuthCredentialInput, "user-123");

    expect(result.id).toEqual("oauth-cred-id");

    // Verify user_identifier is included in INSERT
    const values = sqlCalls[2]?.values ?? [];
    expect(values[0]).toEqual("user-123"); // user_id
    expect(values[1]).toEqual("oauth"); // type
    expect(values[2]).toEqual("google"); // provider
    expect(values[3]).toEqual("test@example.com"); // label
    expect(values[4]).toEqual("test@example.com"); // user_identifier
  });

  it("save: throws on encryption error", async () => {
    const mockCypher = createMockCypher({
      encrypt: () => Promise.resolve([]), // Returns empty array
    });
    const mockSql = createMockSql();

    const adapter = new CypherStorageAdapter(mockCypher, mockSql);
    await expect(adapter.save(testCredentialInput, "user-123")).rejects.toThrow(
      "Failed to encrypt credential: empty response",
    );
  });

  it("save: throws on database error", async () => {
    const mockCypher = createMockCypher();
    const mockSql = createMockSql({ throwError: new Error("Database error") });

    const adapter = new CypherStorageAdapter(mockCypher, mockSql);
    await expect(adapter.save(testCredentialInput, "user-123")).rejects.toThrow("Database error");
  });

  it("save: throws when no row returned", async () => {
    const mockCypher = createMockCypher();
    const mockSql = createMockSql({ queryResult: [] }); // No rows returned

    const adapter = new CypherStorageAdapter(mockCypher, mockSql);
    await expect(adapter.save(testCredentialInput, "user-123")).rejects.toThrow(
      "Failed to create credential: no row returned",
    );
  });

  it("get: decrypts secret on retrieval", async () => {
    const decryptCalls: string[][] = [];
    const mockCypher = createMockCypher({
      decrypt: (ciphertext) => {
        decryptCalls.push(ciphertext);
        return Promise.resolve(ciphertext.map((c) => c.replace("enc:", "")));
      },
    });

    const mockSql = createMockSql({
      queryResult: [
        {
          id: "cred-123",
          user_id: "user-123",
          type: "apikey",
          provider: "openai",
          label: "My API Key",
          user_identifier: null,
          display_name: null,
          is_default: false,
          encrypted_secret: 'enc:{"key":"sk-test-key"}',
          created_at: new Date("2024-01-01T00:00:00Z"),
          updated_at: new Date("2024-01-01T00:00:00Z"),
        },
      ],
    });

    const adapter = new CypherStorageAdapter(mockCypher, mockSql);
    const result = await adapter.get("cred-123", "user-123");

    // Verify decrypt was called
    expect(decryptCalls).toHaveLength(1);
    expect(decryptCalls[0]).toEqual(['enc:{"key":"sk-test-key"}']);

    // Verify decrypted result
    expect(result).toMatchObject({
      id: "cred-123",
      isDefault: false,
      secret: { key: "sk-test-key" },
    });
    expect(result?.userIdentifier).toBeUndefined(); // null in DB becomes undefined
    expect(result?.displayName).toBeUndefined(); // null in DB becomes undefined
  });

  it("get: returns displayName when set", async () => {
    const mockCypher = createMockCypher({
      decrypt: (ciphertext) => Promise.resolve(ciphertext.map((c) => c.replace("enc:", ""))),
    });

    const mockSql = createMockSql({
      queryResult: [
        {
          id: "cred-with-display-name",
          user_id: "user-123",
          type: "apikey",
          provider: "openai",
          label: "My API Key",
          user_identifier: null,
          display_name: "Custom Name",
          is_default: true,
          encrypted_secret: 'enc:{"key":"sk-test-key"}',
          created_at: new Date("2024-01-01T00:00:00Z"),
          updated_at: new Date("2024-01-01T00:00:00Z"),
        },
      ],
    });

    const adapter = new CypherStorageAdapter(mockCypher, mockSql);
    const result = await adapter.get("cred-with-display-name", "user-123");

    expect(result).toBeDefined();
    expect(result?.displayName).toEqual("Custom Name");
    expect(result?.isDefault).toBe(true);
  });

  it("get: returns userIdentifier for OAuth credentials", async () => {
    const mockCypher = createMockCypher({
      decrypt: (ciphertext) => Promise.resolve(ciphertext.map((c) => c.replace("enc:", ""))),
    });

    const mockSql = createMockSql({
      queryResult: [
        {
          id: "oauth-cred-123",
          user_id: "user-123",
          type: "oauth",
          provider: "google",
          label: "test@example.com",
          user_identifier: "test@example.com",
          display_name: null,
          is_default: false,
          encrypted_secret: 'enc:{"access_token":"ya29.test"}',
          created_at: new Date("2024-01-01T00:00:00Z"),
          updated_at: new Date("2024-01-01T00:00:00Z"),
        },
      ],
    });

    const adapter = new CypherStorageAdapter(mockCypher, mockSql);
    const result = await adapter.get("oauth-cred-123", "user-123");

    expect(result).toMatchObject({
      id: "oauth-cred-123",
      userIdentifier: "test@example.com",
      isDefault: false,
      type: "oauth",
    });
  });

  it("get: returns null for not found", async () => {
    const mockCypher = createMockCypher();
    const mockSql = createMockSql({ queryResult: [] });

    const adapter = new CypherStorageAdapter(mockCypher, mockSql);
    const result = await adapter.get("nonexistent", "user-123");
    expect(result).toBeNull();
  });

  it("get: throws on database error", async () => {
    const mockCypher = createMockCypher();
    const mockSql = createMockSql({ throwError: new Error("Connection failed") });

    const adapter = new CypherStorageAdapter(mockCypher, mockSql);
    await expect(adapter.get("cred-123", "user-123")).rejects.toThrow("Connection failed");
  });

  it("list: does not call decrypt", async () => {
    let decryptCalled = false;
    const mockCypher = createMockCypher({
      decrypt: () => {
        decryptCalled = true;
        return Promise.resolve([]);
      },
    });

    const mockSql = createMockSql({
      queryResult: [
        {
          id: "cred-1",
          type: "apikey",
          provider: "openai",
          label: "Key 1",
          user_identifier: null,
          display_name: null,
          is_default: false,
          created_at: new Date("2024-01-01"),
          updated_at: new Date("2024-01-01"),
        },
      ],
    });

    const adapter = new CypherStorageAdapter(mockCypher, mockSql);
    const result = await adapter.list("apikey", "user-123");

    expect(decryptCalled).toBe(false);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: "cred-1", isDefault: false });
    expect(result[0]).not.toHaveProperty("secret");
    expect(result[0]?.displayName).toBeUndefined();
  });

  it("list: returns userIdentifier in summaries", async () => {
    const mockSql = createMockSql({
      queryResult: [
        {
          id: "oauth-cred-1",
          type: "oauth",
          provider: "google",
          label: "test@example.com",
          user_identifier: "test@example.com",
          display_name: null,
          is_default: true,
          created_at: new Date("2024-01-01"),
          updated_at: new Date("2024-01-01"),
        },
      ],
    });

    const adapter = new CypherStorageAdapter(createMockCypher(), mockSql);
    const result = await adapter.list("oauth", "user-123");

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: "oauth-cred-1", userIdentifier: "test@example.com" });
  });

  it("list: returns displayName when set", async () => {
    const mockSql = createMockSql({
      queryResult: [
        {
          id: "cred-with-name",
          type: "apikey",
          provider: "openai",
          label: "My API Key",
          user_identifier: null,
          display_name: "Production Key",
          is_default: false,
          created_at: new Date("2024-01-01"),
          updated_at: new Date("2024-01-01"),
        },
      ],
    });

    const adapter = new CypherStorageAdapter(createMockCypher(), mockSql);
    const result = await adapter.list("apikey", "user-123");

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ displayName: "Production Key" });
  });

  it("update: encrypts secret and returns metadata", async () => {
    const encryptCalls: string[][] = [];
    const mockCypher = createMockCypher({
      encrypt: (plaintext) => {
        encryptCalls.push(plaintext);
        return Promise.resolve(plaintext.map((p) => `enc:${p}`));
      },
    });

    const sqlCalls: { query: string; values: unknown[] }[] = [];
    const mockSql = createMockSql({
      queryResult: [{ created_at: new Date("2024-01-01"), updated_at: new Date("2024-01-02") }],
      trackCalls: sqlCalls,
    });

    const adapter = new CypherStorageAdapter(mockCypher, mockSql);
    const metadata = await adapter.update("cred-123", testCredentialInput, "user-123");

    // Verify metadata returned
    expect(metadata).toMatchObject({
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-02T00:00:00.000Z",
    });

    // Verify encrypt was called
    expect(encryptCalls).toHaveLength(1);
    expect(encryptCalls[0]).toEqual(['{"key":"sk-test-key"}']);

    // Verify SQL UPDATE was called
    // Note: 3 calls now - first is SET LOCAL ROLE, second is SET_CONFIG for RLS, third is the UPDATE
    expect(sqlCalls).toHaveLength(3);
    expect(sqlCalls[2]?.query).toContain("UPDATE");
    expect(sqlCalls[2]?.query).toContain("deleted_at IS NULL");
    const values = sqlCalls[2]?.values ?? [];
    expect(values[0]).toEqual("apikey"); // type
    expect(values[1]).toEqual("openai"); // provider
    expect(values[2]).toEqual("My API Key"); // label
    expect(values[3]).toBeNull(); // user_identifier (null for apikey)
    expect(values[4]).toEqual('enc:{"key":"sk-test-key"}'); // encrypted_secret
    expect(values[5]).toEqual("cred-123"); // id
    expect(values[6]).toEqual("user-123"); // user_id
  });

  it("update: throws on encryption error", async () => {
    const mockCypher = createMockCypher({ encrypt: () => Promise.resolve([]) });
    const mockSql = createMockSql();

    const adapter = new CypherStorageAdapter(mockCypher, mockSql);
    await expect(adapter.update("cred-123", testCredentialInput, "user-123")).rejects.toThrow(
      "Failed to encrypt credential: empty response",
    );
  });

  it("update: throws on database error", async () => {
    const mockCypher = createMockCypher();
    const mockSql = createMockSql({ throwError: new Error("Update failed") });

    const adapter = new CypherStorageAdapter(mockCypher, mockSql);
    await expect(adapter.update("cred-123", testCredentialInput, "user-123")).rejects.toThrow(
      "Update failed",
    );
  });

  it("update: throws when credential not found", async () => {
    const mockCypher = createMockCypher();
    const mockSql = createMockSql({ queryResult: [] }); // No rows returned

    const adapter = new CypherStorageAdapter(mockCypher, mockSql);
    await expect(adapter.update("nonexistent", testCredentialInput, "user-123")).rejects.toThrow(
      "Credential not found",
    );
  });

  it("delete: soft deletes by setting deleted_at", async () => {
    const sqlCalls: { query: string; values: unknown[] }[] = [];
    // RETURNING yields a non-default credential — no promotion needed
    const mockSql = createMockSql({
      queryResult: [{ provider: "openai", is_default: false }],
      trackCalls: sqlCalls,
    });

    const adapter = new CypherStorageAdapter(createMockCypher(), mockSql);
    await adapter.delete("cred-123", "user-456");

    // RLS (0,1) + UPDATE with RETURNING (2) = 3 calls, no promotion UPDATE
    expect(sqlCalls).toHaveLength(3);
    expect(sqlCalls[2]?.query).toContain("UPDATE");
    expect(sqlCalls[2]?.query).toContain("deleted_at");
    const values = sqlCalls[2]?.values ?? [];
    expect(values[0]).toEqual("cred-123"); // id
    expect(values[1]).toEqual("user-456"); // user_id
  });

  it("delete: promotes next-oldest credential when deleting the default", async () => {
    const sqlCalls: { query: string; values: unknown[] }[] = [];
    // RLS (0,1), soft-delete RETURNING (2) says it was default, promotion UPDATE (3)
    const mockSql = createSequentialMockSql(
      [
        { result: [] }, // 0: SET LOCAL ROLE
        { result: [] }, // 1: set_config
        { result: [{ provider: "openai", is_default: true }] }, // 2: soft-delete RETURNING
        { result: [] }, // 3: promote next-oldest
      ],
      sqlCalls,
    );

    const adapter = new CypherStorageAdapter(createMockCypher(), mockSql);
    await adapter.delete("default-cred", "user-123");

    // RLS (0,1) + soft-delete (2) + promotion (3) = 4 calls
    expect(sqlCalls).toHaveLength(4);
    // Verify the promotion UPDATE targets the right provider
    const promoQuery = sqlCalls[3]?.query ?? "";
    expect(promoQuery).toContain("UPDATE");
    expect(promoQuery).toContain("is_default");
    expect(promoQuery).toContain("ORDER BY");
    const promoValues = sqlCalls[3]?.values ?? [];
    expect(promoValues[0]).toEqual("user-123"); // user_id in subquery
    expect(promoValues[1]).toEqual("openai"); // provider in subquery
  });

  it("delete: skips promotion when deleted credential was not the default", async () => {
    const sqlCalls: { query: string; values: unknown[] }[] = [];
    const mockSql = createSequentialMockSql(
      [
        { result: [] }, // 0: SET LOCAL ROLE
        { result: [] }, // 1: set_config
        { result: [{ provider: "openai", is_default: false }] }, // 2: soft-delete RETURNING — not default
      ],
      sqlCalls,
    );

    const adapter = new CypherStorageAdapter(createMockCypher(), mockSql);
    await adapter.delete("non-default-cred", "user-123");

    // Only 3 calls — no promotion UPDATE
    expect(sqlCalls).toHaveLength(3);
  });

  it("delete: skips promotion when credential did not exist", async () => {
    const sqlCalls: { query: string; values: unknown[] }[] = [];
    const mockSql = createSequentialMockSql(
      [
        { result: [] }, // 0: SET LOCAL ROLE
        { result: [] }, // 1: set_config
        { result: [] }, // 2: soft-delete RETURNING — no rows (didn't exist)
      ],
      sqlCalls,
    );

    const adapter = new CypherStorageAdapter(createMockCypher(), mockSql);
    await adapter.delete("nonexistent", "user-123");

    // Only 3 calls — no promotion UPDATE
    expect(sqlCalls).toHaveLength(3);
  });

  it("delete: throws on database error", async () => {
    const mockCypher = createMockCypher();
    const mockSql = createMockSql({ throwError: new Error("Delete failed") });

    const adapter = new CypherStorageAdapter(mockCypher, mockSql);
    await expect(adapter.delete("cred-123", "user-123")).rejects.toThrow("Delete failed");
  });

  it("updateMetadata: updates display_name column without touching encrypted_secret", async () => {
    const sqlCalls: { query: string; values: unknown[] }[] = [];
    const mockSql = createMockSql({
      queryResult: [{ created_at: new Date("2024-01-01"), updated_at: new Date("2024-01-03") }],
      trackCalls: sqlCalls,
    });

    // Cypher should NOT be called for metadata-only updates
    let cypherCalled = false;
    const mockCypher = createMockCypher({
      encrypt: () => {
        cypherCalled = true;
        return Promise.resolve([]);
      },
      decrypt: () => {
        cypherCalled = true;
        return Promise.resolve([]);
      },
    });

    const adapter = new CypherStorageAdapter(mockCypher, mockSql);
    const metadata = await adapter.updateMetadata(
      "cred-123",
      { displayName: "My Custom Name" },
      "user-123",
    );

    // Verify metadata returned
    expect(metadata).toMatchObject({
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-03T00:00:00.000Z",
    });

    // Verify NO encrypt/decrypt calls (critical: no touching secrets)
    expect(cypherCalled).toBe(false);

    // Verify SQL UPDATE was called with display_name only
    expect(sqlCalls).toHaveLength(3); // SET LOCAL ROLE, SET_CONFIG, UPDATE
    const updateQuery = sqlCalls[2]?.query ?? "";
    expect(updateQuery).toContain("UPDATE");
    expect(updateQuery).toContain("display_name");
    expect(updateQuery).not.toContain("encrypted_secret");

    const values = sqlCalls[2]?.values ?? [];
    expect(values[0]).toEqual("My Custom Name"); // display_name
    expect(values[1]).toEqual("cred-123"); // id
    expect(values[2]).toEqual("user-123"); // user_id
  });

  it("updateMetadata: throws when credential not found", async () => {
    const mockSql = createMockSql({ queryResult: [] }); // No rows returned

    const adapter = new CypherStorageAdapter(createMockCypher(), mockSql);
    await expect(
      adapter.updateMetadata("nonexistent", { displayName: "Test" }, "user-123"),
    ).rejects.toThrow("Credential not found");
  });

  describe("auto-default logic", () => {
    it("save: first credential for a provider gets is_default = true via NOT EXISTS subquery", async () => {
      const sqlCalls: { query: string; values: unknown[] }[] = [];
      const mockSql = createMockSql({
        queryResult: [
          {
            id: "first-cred",
            is_default: true,
            created_at: new Date("2024-01-01T00:00:00Z"),
            updated_at: new Date("2024-01-01T00:00:00Z"),
          },
        ],
        trackCalls: sqlCalls,
      });

      const adapter = new CypherStorageAdapter(createMockCypher(), mockSql);
      const result = await adapter.save(testCredentialInput, "user-123");

      expect(result.isDefault).toBe(true);

      // Verify the INSERT SQL uses NOT EXISTS subquery for auto-default
      const insertQuery = sqlCalls[2]?.query ?? "";
      expect(insertQuery).toContain("NOT EXISTS");
      expect(insertQuery).toContain("is_default");
    });

    it("save: second credential for same provider gets is_default = false", async () => {
      const mockSql = createMockSql({
        queryResult: [
          {
            id: "second-cred",
            is_default: false,
            created_at: new Date("2024-01-01T00:00:00Z"),
            updated_at: new Date("2024-01-01T00:00:00Z"),
          },
        ],
      });

      const adapter = new CypherStorageAdapter(createMockCypher(), mockSql);
      const result = await adapter.save(testCredentialInput, "user-123");

      expect(result.isDefault).toBe(false);
    });

    it("save: retries with is_default = false on unique constraint violation from idx_credential_default_per_provider", async () => {
      const sqlCalls: { query: string; values: unknown[] }[] = [];
      const constraintError = new Error("unique constraint violation");
      Object.assign(constraintError, { constraint_name: "idx_credential_default_per_provider" });

      // RLS setup (call 0, 1) succeed, INSERT (call 2) fails with constraint error,
      // then RLS setup retry (call 3, 4) succeed, retry INSERT (call 5) succeeds
      const mockSql = createSequentialMockSql(
        [
          { result: [] }, // SET LOCAL ROLE
          { result: [] }, // set_config
          { error: constraintError }, // INSERT — constraint violation
          { result: [] }, // SET LOCAL ROLE (retry)
          { result: [] }, // set_config (retry)
          {
            result: [
              {
                id: "retry-cred",
                is_default: false,
                created_at: new Date("2024-01-01T00:00:00Z"),
                updated_at: new Date("2024-01-01T00:00:00Z"),
              },
            ],
          }, // retry INSERT with is_default = false
        ],
        sqlCalls,
      );

      const adapter = new CypherStorageAdapter(createMockCypher(), mockSql);
      const result = await adapter.save(testCredentialInput, "user-123");

      expect(result.id).toBe("retry-cred");
      expect(result.isDefault).toBe(false);
    });

    it("save: does not retry on unrelated database errors", async () => {
      const mockSql = createMockSql({ throwError: new Error("Connection lost") });

      const adapter = new CypherStorageAdapter(createMockCypher(), mockSql);
      await expect(adapter.save(testCredentialInput, "user-123")).rejects.toThrow(
        "Connection lost",
      );
    });

    it("upsert: re-auth into non-default credential when no default exists becomes default", async () => {
      const sqlCalls: { query: string; values: unknown[] }[] = [];
      const mockSql = createMockSql({
        queryResult: [
          {
            id: "existing-cred",
            is_default: true,
            created_at: new Date("2024-01-01T00:00:00Z"),
            updated_at: new Date("2024-01-02T00:00:00Z"),
          },
        ],
        trackCalls: sqlCalls,
      });

      const adapter = new CypherStorageAdapter(createMockCypher(), mockSql);
      const result = await adapter.upsert(testOAuthCredentialInput, "user-123");

      expect(result.isDefault).toBe(true);

      // Verify the upsert SQL includes conditional is_default logic in DO UPDATE SET
      const upsertQuery = sqlCalls[2]?.query ?? "";
      expect(upsertQuery).toContain("NOT EXISTS");
      expect(upsertQuery).toContain("is_default");
    });

    it("upsert: re-auth into non-default credential when default exists stays non-default", async () => {
      const mockSql = createMockSql({
        queryResult: [
          {
            id: "existing-cred",
            is_default: false,
            created_at: new Date("2024-01-01T00:00:00Z"),
            updated_at: new Date("2024-01-02T00:00:00Z"),
          },
        ],
      });

      const adapter = new CypherStorageAdapter(createMockCypher(), mockSql);
      const result = await adapter.upsert(testOAuthCredentialInput, "user-123");

      expect(result.isDefault).toBe(false);
    });
  });

  describe("setDefault", () => {
    it("swaps default from credential A to credential B", async () => {
      const sqlCalls: { query: string; values: unknown[] }[] = [];
      // RLS setup (0, 1), SELECT credential (2), UPDATE unset old (3), UPDATE set new (4)
      const mockSql = createSequentialMockSql(
        [
          { result: [] }, // 0: SET LOCAL ROLE
          { result: [] }, // 1: set_config
          { result: [{ id: "cred-B", provider: "openai", is_default: false, deleted_at: null }] }, // 2: SELECT credential
          { result: [{ count: 1 }] }, // 3: UPDATE unset old default
          { result: [{ id: "cred-B", is_default: true }] }, // 4: UPDATE set new default
        ],
        sqlCalls,
      );

      const adapter = new CypherStorageAdapter(createMockCypher(), mockSql);
      await adapter.setDefault("cred-B", "user-123");

      // Verify: RLS (0,1) + SELECT (2) + UPDATE unset (3) + UPDATE set (4) = 5 calls
      expect(sqlCalls).toHaveLength(5);
      // SELECT: lookup credential
      expect(sqlCalls[2]?.query).toContain("SELECT");
      // First UPDATE: unset old default for same provider
      expect(sqlCalls[3]?.query).toContain("UPDATE");
      expect(sqlCalls[3]?.query).toContain("is_default");
      // Second UPDATE: set new default
      expect(sqlCalls[4]?.query).toContain("UPDATE");
    });

    it("no-op if credential is already the default", async () => {
      const sqlCalls: { query: string; values: unknown[] }[] = [];
      // RLS setup (0, 1), then the credential lookup returns is_default = true
      const mockSql = createSequentialMockSql(
        [
          { result: [] }, // SET LOCAL ROLE
          { result: [] }, // set_config
          { result: [{ id: "cred-A", provider: "openai", is_default: true, deleted_at: null }] }, // SELECT — credential is already default
        ],
        sqlCalls,
      );

      const adapter = new CypherStorageAdapter(createMockCypher(), mockSql);
      await adapter.setDefault("cred-A", "user-123");

      // Should only have the SELECT + RLS setup — no UPDATE calls
      expect(sqlCalls).toHaveLength(3);
    });

    it("throws when credential is soft-deleted or doesn't exist", async () => {
      // RLS setup (0, 1), then SELECT returns no rows (credential not found / soft-deleted)
      const mockSql = createSequentialMockSql([
        { result: [] }, // SET LOCAL ROLE
        { result: [] }, // set_config
        { result: [] }, // SELECT — no credential found
      ]);

      const adapter = new CypherStorageAdapter(createMockCypher(), mockSql);
      await expect(adapter.setDefault("deleted-cred", "user-123")).rejects.toThrow(
        "Credential not found",
      );
    });

    it("retries full swap on unique constraint violation from concurrent race", async () => {
      const sqlCalls: { query: string; values: unknown[] }[] = [];
      const constraintError = new Error("unique constraint violation");
      Object.assign(constraintError, { constraint_name: "idx_credential_default_per_provider" });

      // First attempt: RLS (0,1), SELECT (2) finds cred, UPDATE unset (3) succeeds,
      // UPDATE set (4) fails with constraint violation
      // Retry: RLS (5,6), SELECT (7) finds cred, UPDATE unset (8), UPDATE set (9) succeeds
      const mockSql = createSequentialMockSql(
        [
          { result: [] }, // 0: SET LOCAL ROLE
          { result: [] }, // 1: set_config
          { result: [{ id: "cred-B", provider: "openai", is_default: false, deleted_at: null }] }, // 2: SELECT credential
          { result: [{ count: 1 }] }, // 3: UPDATE unset old default
          { error: constraintError }, // 4: UPDATE set new — constraint violation
          { result: [] }, // 5: SET LOCAL ROLE (retry)
          { result: [] }, // 6: set_config (retry)
          { result: [{ id: "cred-B", provider: "openai", is_default: false, deleted_at: null }] }, // 7: SELECT credential (retry)
          { result: [{ count: 1 }] }, // 8: UPDATE unset old default (retry)
          { result: [{ id: "cred-B", provider: "openai", is_default: true, deleted_at: null }] }, // 9: UPDATE set new (retry succeeds)
        ],
        sqlCalls,
      );

      const adapter = new CypherStorageAdapter(createMockCypher(), mockSql);
      // Should not throw — retry succeeds
      await adapter.setDefault("cred-B", "user-123");

      // Verify both attempts happened (10 total SQL calls)
      expect(sqlCalls).toHaveLength(10);
    });

    it("throws after retry also fails with constraint violation (no infinite loop)", async () => {
      const sqlCalls: { query: string; values: unknown[] }[] = [];
      const constraintError = new Error("unique constraint violation");
      Object.assign(constraintError, { constraint_name: "idx_credential_default_per_provider" });

      // First attempt: RLS (0,1), SELECT (2) finds cred, UPDATE unset (3) succeeds,
      // UPDATE set (4) fails with constraint violation
      // Retry: RLS (5,6), SELECT (7) finds cred, UPDATE unset (8) succeeds,
      // UPDATE set (9) ALSO fails with constraint violation — should throw, not retry again
      const mockSql = createSequentialMockSql(
        [
          { result: [] }, // 0: SET LOCAL ROLE
          { result: [] }, // 1: set_config
          { result: [{ id: "cred-B", provider: "openai", is_default: false, deleted_at: null }] }, // 2: SELECT credential
          { result: [{ count: 1 }] }, // 3: UPDATE unset old default
          { error: constraintError }, // 4: UPDATE set new — constraint violation
          { result: [] }, // 5: SET LOCAL ROLE (retry)
          { result: [] }, // 6: set_config (retry)
          { result: [{ id: "cred-B", provider: "openai", is_default: false, deleted_at: null }] }, // 7: SELECT credential (retry)
          { result: [{ count: 1 }] }, // 8: UPDATE unset old default (retry)
          { error: constraintError }, // 9: UPDATE set new — constraint violation again
        ],
        sqlCalls,
      );

      const adapter = new CypherStorageAdapter(createMockCypher(), mockSql);
      await expect(adapter.setDefault("cred-B", "user-123")).rejects.toThrow(
        "unique constraint violation",
      );

      // Verify exactly 2 attempts (10 total SQL calls), no third attempt
      expect(sqlCalls).toHaveLength(10);
    });
  });

  describe("getDefaultByProvider", () => {
    it("returns the default credential with decrypted secret", async () => {
      const mockCypher = createMockCypher({
        decrypt: (ciphertext) => Promise.resolve(ciphertext.map((c) => c.replace("enc:", ""))),
      });

      const mockSql = createMockSql({
        queryResult: [
          {
            id: "default-cred",
            user_id: "user-123",
            type: "apikey",
            provider: "openai",
            label: "Default Key",
            user_identifier: null,
            display_name: null,
            is_default: true,
            encrypted_secret: 'enc:{"key":"sk-default"}',
            created_at: new Date("2024-01-01T00:00:00Z"),
            updated_at: new Date("2024-01-01T00:00:00Z"),
          },
        ],
      });

      const adapter = new CypherStorageAdapter(mockCypher, mockSql);
      const result = await adapter.getDefaultByProvider("openai", "user-123");

      expect(result).toMatchObject({
        id: "default-cred",
        provider: "openai",
        isDefault: true,
        secret: { key: "sk-default" },
      });
    });

    it("returns null when no default exists", async () => {
      const mockSql = createMockSql({ queryResult: [] });

      const adapter = new CypherStorageAdapter(createMockCypher(), mockSql);
      const result = await adapter.getDefaultByProvider("openai", "user-123");

      expect(result).toBeNull();
    });
  });
});
