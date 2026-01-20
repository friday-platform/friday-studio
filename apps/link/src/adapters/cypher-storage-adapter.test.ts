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
          created_at: new Date("2024-01-01T00:00:00Z"),
          updated_at: new Date("2024-01-01T00:00:00Z"),
        },
      ],
      trackCalls: sqlCalls,
    });

    const adapter = new CypherStorageAdapter(mockCypher, mockSql);
    const result = await adapter.save(testCredentialInput, "user-123");

    // Verify returned SaveResult
    expect(result.id).toEqual("pg-generated-id");
    expect(result.metadata.createdAt).toEqual("2024-01-01T00:00:00.000Z");
    expect(result.metadata.updatedAt).toEqual("2024-01-01T00:00:00.000Z");

    // Verify encrypt was called with JSON-serialized secret
    expect(encryptCalls.length).toEqual(1);
    expect(encryptCalls[0]).toEqual(['{"key":"sk-test-key"}']);

    // Verify SQL was called with encrypted secret (no id passed - Postgres generates it)
    // Note: 3 calls now - first is SET LOCAL ROLE, second is SET_CONFIG for RLS, third is the INSERT
    expect(sqlCalls.length).toEqual(3);
    const values = sqlCalls[2]?.values ?? []; // Get values from the INSERT query (third call)
    expect(values[0]).toEqual("user-123"); // user_id
    expect(values[1]).toEqual("apikey"); // type
    expect(values[2]).toEqual("openai"); // provider
    expect(values[3]).toEqual("My API Key"); // label
    expect(values[4]).toEqual(null); // user_identifier (null for apikey)
    expect(values[5]).toEqual('enc:{"key":"sk-test-key"}'); // encrypted_secret
  });

  it("save: persists userIdentifier for OAuth credentials", async () => {
    const sqlCalls: { query: string; values: unknown[] }[] = [];
    const mockSql = createMockSql({
      queryResult: [
        {
          id: "oauth-cred-id",
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
          encrypted_secret: 'enc:{"key":"sk-test-key"}',
          created_at: new Date("2024-01-01T00:00:00Z"),
          updated_at: new Date("2024-01-01T00:00:00Z"),
        },
      ],
    });

    const adapter = new CypherStorageAdapter(mockCypher, mockSql);
    const result = await adapter.get("cred-123", "user-123");

    // Verify decrypt was called
    expect(decryptCalls.length).toEqual(1);
    expect(decryptCalls[0]).toEqual(['enc:{"key":"sk-test-key"}']);

    // Verify decrypted result
    expect(result).toBeDefined();
    expect(result!.id).toEqual("cred-123");
    expect(result!.secret).toEqual({ key: "sk-test-key" });
    expect(result!.userIdentifier).toEqual(undefined); // null in DB becomes undefined
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
          encrypted_secret: 'enc:{"access_token":"ya29.test"}',
          created_at: new Date("2024-01-01T00:00:00Z"),
          updated_at: new Date("2024-01-01T00:00:00Z"),
        },
      ],
    });

    const adapter = new CypherStorageAdapter(mockCypher, mockSql);
    const result = await adapter.get("oauth-cred-123", "user-123");

    expect(result).toBeDefined();
    expect(result!.id).toEqual("oauth-cred-123");
    expect(result!.userIdentifier).toEqual("test@example.com");
    expect(result!.type).toEqual("oauth");
  });

  it("get: returns null for not found", async () => {
    const mockCypher = createMockCypher();
    const mockSql = createMockSql({ queryResult: [] });

    const adapter = new CypherStorageAdapter(mockCypher, mockSql);
    const result = await adapter.get("nonexistent", "user-123");
    expect(result).toEqual(null);
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
          created_at: new Date("2024-01-01"),
          updated_at: new Date("2024-01-01"),
        },
      ],
    });

    const adapter = new CypherStorageAdapter(mockCypher, mockSql);
    const result = await adapter.list("apikey", "user-123");

    expect(decryptCalled).toEqual(false);
    expect(result.length).toEqual(1);
    expect(result[0]?.id).toEqual("cred-1");
    // Summaries should not have secret field
    expect("secret" in (result[0] ?? {})).toEqual(false);
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
          created_at: new Date("2024-01-01"),
          updated_at: new Date("2024-01-01"),
        },
      ],
    });

    const adapter = new CypherStorageAdapter(createMockCypher(), mockSql);
    const result = await adapter.list("oauth", "user-123");

    expect(result.length).toEqual(1);
    expect(result[0]?.id).toEqual("oauth-cred-1");
    expect(result[0]?.userIdentifier).toEqual("test@example.com");
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
    expect(metadata.createdAt).toEqual("2024-01-01T00:00:00.000Z");
    expect(metadata.updatedAt).toEqual("2024-01-02T00:00:00.000Z");

    // Verify encrypt was called
    expect(encryptCalls.length).toEqual(1);
    expect(encryptCalls[0]).toEqual(['{"key":"sk-test-key"}']);

    // Verify SQL UPDATE was called
    // Note: 3 calls now - first is SET LOCAL ROLE, second is SET_CONFIG for RLS, third is the UPDATE
    expect(sqlCalls.length).toEqual(3);
    expect(sqlCalls[2]?.query.includes("UPDATE")).toEqual(true);
    expect(sqlCalls[2]?.query.includes("deleted_at IS NULL")).toEqual(true);
    const values = sqlCalls[2]?.values ?? [];
    expect(values[0]).toEqual("apikey"); // type
    expect(values[1]).toEqual("openai"); // provider
    expect(values[2]).toEqual("My API Key"); // label
    expect(values[3]).toEqual(null); // user_identifier (null for apikey)
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
    const mockSql = createMockSql({ trackCalls: sqlCalls });

    const adapter = new CypherStorageAdapter(createMockCypher(), mockSql);
    await adapter.delete("cred-123", "user-456");

    // Note: 3 calls now - first is SET LOCAL ROLE, second is SET_CONFIG for RLS, third is the UPDATE
    expect(sqlCalls.length).toEqual(3);
    // Verify it's an UPDATE (soft delete), not DELETE
    expect(sqlCalls[2]?.query.includes("UPDATE")).toEqual(true);
    expect(sqlCalls[2]?.query.includes("deleted_at")).toEqual(true);
    const values = sqlCalls[2]?.values ?? [];
    expect(values[0]).toEqual("cred-123"); // id
    expect(values[1]).toEqual("user-456"); // user_id
  });

  it("delete: throws on database error", async () => {
    const mockCypher = createMockCypher();
    const mockSql = createMockSql({ throwError: new Error("Delete failed") });

    const adapter = new CypherStorageAdapter(mockCypher, mockSql);
    await expect(adapter.delete("cred-123", "user-123")).rejects.toThrow("Delete failed");
  });
});
