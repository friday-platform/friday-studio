import { assertEquals, assertExists, assertRejects } from "@std/assert";
import type { Sql } from "postgres";
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
  // biome-ignore lint/suspicious/noExplicitAny: TransactionSql type is complex and not exported, using any for test mocks
  // deno-lint-ignore no-explicit-any require-await
  mockSql.begin = async <T>(callback: (tx: any) => Promise<T>): Promise<T> => {
    return callback(handler as Sql);
  };

  return mockSql;
}

Deno.test("CypherStorageAdapter", async (t) => {
  const testCredentialInput: CredentialInput = {
    type: "apikey",
    provider: "openai",
    label: "My API Key",
    secret: { key: "sk-test-key" },
  };

  await t.step("save: encrypts secret before storing and returns ID", async () => {
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
    assertEquals(result.id, "pg-generated-id");
    assertEquals(result.metadata.createdAt, "2024-01-01T00:00:00.000Z");
    assertEquals(result.metadata.updatedAt, "2024-01-01T00:00:00.000Z");

    // Verify encrypt was called with JSON-serialized secret
    assertEquals(encryptCalls.length, 1);
    assertEquals(encryptCalls[0], ['{"key":"sk-test-key"}']);

    // Verify SQL was called with encrypted secret (no id passed - Postgres generates it)
    // Note: 3 calls now - first is SET LOCAL ROLE, second is SET_CONFIG for RLS, third is the INSERT
    assertEquals(sqlCalls.length, 3);
    const values = sqlCalls[2]?.values ?? []; // Get values from the INSERT query (third call)
    assertEquals(values[0], "user-123"); // user_id
    assertEquals(values[1], "apikey"); // type
    assertEquals(values[2], "openai"); // provider
    assertEquals(values[3], "My API Key"); // label
    assertEquals(values[4], 'enc:{"key":"sk-test-key"}'); // encrypted_secret
  });

  await t.step("save: throws on encryption error", async () => {
    const mockCypher = createMockCypher({
      encrypt: () => Promise.resolve([]), // Returns empty array
    });
    const mockSql = createMockSql();

    const adapter = new CypherStorageAdapter(mockCypher, mockSql);
    await assertRejects(
      () => adapter.save(testCredentialInput, "user-123"),
      Error,
      "Failed to encrypt credential: empty response",
    );
  });

  await t.step("save: throws on database error", async () => {
    const mockCypher = createMockCypher();
    const mockSql = createMockSql({ throwError: new Error("Database error") });

    const adapter = new CypherStorageAdapter(mockCypher, mockSql);
    await assertRejects(
      () => adapter.save(testCredentialInput, "user-123"),
      Error,
      "Database error",
    );
  });

  await t.step("save: throws when no row returned", async () => {
    const mockCypher = createMockCypher();
    const mockSql = createMockSql({ queryResult: [] }); // No rows returned

    const adapter = new CypherStorageAdapter(mockCypher, mockSql);
    await assertRejects(
      () => adapter.save(testCredentialInput, "user-123"),
      Error,
      "Failed to create credential: no row returned",
    );
  });

  await t.step("get: decrypts secret on retrieval", async () => {
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
          encrypted_secret: 'enc:{"key":"sk-test-key"}',
          created_at: new Date("2024-01-01T00:00:00Z"),
          updated_at: new Date("2024-01-01T00:00:00Z"),
        },
      ],
    });

    const adapter = new CypherStorageAdapter(mockCypher, mockSql);
    const result = await adapter.get("cred-123", "user-123");

    // Verify decrypt was called
    assertEquals(decryptCalls.length, 1);
    assertEquals(decryptCalls[0], ['enc:{"key":"sk-test-key"}']);

    // Verify decrypted result
    assertExists(result);
    assertEquals(result.id, "cred-123");
    assertEquals(result.secret, { key: "sk-test-key" });
  });

  await t.step("get: returns null for not found", async () => {
    const mockCypher = createMockCypher();
    const mockSql = createMockSql({ queryResult: [] });

    const adapter = new CypherStorageAdapter(mockCypher, mockSql);
    const result = await adapter.get("nonexistent", "user-123");
    assertEquals(result, null);
  });

  await t.step("get: throws on database error", async () => {
    const mockCypher = createMockCypher();
    const mockSql = createMockSql({ throwError: new Error("Connection failed") });

    const adapter = new CypherStorageAdapter(mockCypher, mockSql);
    await assertRejects(() => adapter.get("cred-123", "user-123"), Error, "Connection failed");
  });

  await t.step("list: does not call decrypt", async () => {
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
          created_at: new Date("2024-01-01"),
          updated_at: new Date("2024-01-01"),
        },
      ],
    });

    const adapter = new CypherStorageAdapter(mockCypher, mockSql);
    const result = await adapter.list("apikey", "user-123");

    assertEquals(decryptCalled, false);
    assertEquals(result.length, 1);
    assertEquals(result[0]?.id, "cred-1");
    // Summaries should not have secret field
    assertEquals("secret" in (result[0] ?? {}), false);
  });

  await t.step("update: encrypts secret and returns metadata", async () => {
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
    assertEquals(metadata.createdAt, "2024-01-01T00:00:00.000Z");
    assertEquals(metadata.updatedAt, "2024-01-02T00:00:00.000Z");

    // Verify encrypt was called
    assertEquals(encryptCalls.length, 1);
    assertEquals(encryptCalls[0], ['{"key":"sk-test-key"}']);

    // Verify SQL UPDATE was called
    // Note: 3 calls now - first is SET LOCAL ROLE, second is SET_CONFIG for RLS, third is the UPDATE
    assertEquals(sqlCalls.length, 3);
    assertEquals(sqlCalls[2]?.query.includes("UPDATE"), true);
    assertEquals(sqlCalls[2]?.query.includes("deleted_at IS NULL"), true);
    const values = sqlCalls[2]?.values ?? [];
    assertEquals(values[0], "apikey"); // type
    assertEquals(values[1], "openai"); // provider
    assertEquals(values[2], "My API Key"); // label
    assertEquals(values[3], 'enc:{"key":"sk-test-key"}'); // encrypted_secret
    assertEquals(values[4], "cred-123"); // id
    assertEquals(values[5], "user-123"); // user_id
  });

  await t.step("update: throws on encryption error", async () => {
    const mockCypher = createMockCypher({ encrypt: () => Promise.resolve([]) });
    const mockSql = createMockSql();

    const adapter = new CypherStorageAdapter(mockCypher, mockSql);
    await assertRejects(
      () => adapter.update("cred-123", testCredentialInput, "user-123"),
      Error,
      "Failed to encrypt credential: empty response",
    );
  });

  await t.step("update: throws on database error", async () => {
    const mockCypher = createMockCypher();
    const mockSql = createMockSql({ throwError: new Error("Update failed") });

    const adapter = new CypherStorageAdapter(mockCypher, mockSql);
    await assertRejects(
      () => adapter.update("cred-123", testCredentialInput, "user-123"),
      Error,
      "Update failed",
    );
  });

  await t.step("update: throws when credential not found", async () => {
    const mockCypher = createMockCypher();
    const mockSql = createMockSql({ queryResult: [] }); // No rows returned

    const adapter = new CypherStorageAdapter(mockCypher, mockSql);
    await assertRejects(
      () => adapter.update("nonexistent", testCredentialInput, "user-123"),
      Error,
      "Credential not found",
    );
  });

  await t.step("delete: soft deletes by setting deleted_at", async () => {
    const sqlCalls: { query: string; values: unknown[] }[] = [];
    const mockSql = createMockSql({ trackCalls: sqlCalls });

    const adapter = new CypherStorageAdapter(createMockCypher(), mockSql);
    await adapter.delete("cred-123", "user-456");

    // Note: 3 calls now - first is SET LOCAL ROLE, second is SET_CONFIG for RLS, third is the UPDATE
    assertEquals(sqlCalls.length, 3);
    // Verify it's an UPDATE (soft delete), not DELETE
    assertEquals(sqlCalls[2]?.query.includes("UPDATE"), true);
    assertEquals(sqlCalls[2]?.query.includes("deleted_at"), true);
    const values = sqlCalls[2]?.values ?? [];
    assertEquals(values[0], "cred-123"); // id
    assertEquals(values[1], "user-456"); // user_id
  });

  await t.step("delete: throws on database error", async () => {
    const mockCypher = createMockCypher();
    const mockSql = createMockSql({ throwError: new Error("Delete failed") });

    const adapter = new CypherStorageAdapter(mockCypher, mockSql);
    await assertRejects(() => adapter.delete("cred-123", "user-123"), Error, "Delete failed");
  });
});
