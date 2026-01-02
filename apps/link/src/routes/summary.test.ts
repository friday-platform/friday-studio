import { rm } from "node:fs/promises";
import { assertEquals, assertExists, assertObjectMatch } from "@std/assert";
import { z } from "zod";
import { DenoKVStorageAdapter } from "../adapters/deno-kv-adapter.ts";
import { NoOpPlatformRouteRepository } from "../adapters/platform-route-repository.ts";
import { createApp } from "../index.ts";
import { OAuthService } from "../oauth/service.ts";
import { registry } from "../providers/registry.ts";
import { CredentialSummarySchema } from "../types.ts";

/**
 * Test providers for summary endpoint tests
 */
const testProviders = {
  apikey1: {
    id: "test-summary-apikey-1",
    type: "apikey" as const,
    displayName: "Test Summary API Key 1",
    description: "First API key provider for summary tests",
    setupInstructions: "# Test",
    secretSchema: z.object({ apiKey: z.string() }),
  },
  apikey2: {
    id: "test-summary-apikey-2",
    type: "apikey" as const,
    displayName: "Test Summary API Key 2",
    description: "Second API key provider for summary tests",
    setupInstructions: "# Test",
    secretSchema: z.object({ token: z.string() }),
  },
};

/**
 * Response schema for /v1/summary endpoint.
 * Note: credentials array has a simplified shape without metadata.
 */
const SummaryResponseSchema = z.object({
  providers: z.array(
    z.object({ id: z.string(), displayName: z.string(), type: z.enum(["apikey", "oauth"]) }),
  ),
  credentials: z.array(
    z.object({
      id: z.string(),
      type: z.enum(["apikey", "oauth"]),
      provider: z.string(),
      label: z.string(),
    }),
  ),
});

Deno.test("GET /v1/summary endpoint", async (t) => {
  const tempDir = await Deno.makeTempDir();
  const storage = new DenoKVStorageAdapter(`${tempDir}/kv.db`);
  const oauthService = new OAuthService(registry, storage);
  const app = await createApp(storage, oauthService, new NoOpPlatformRouteRepository());

  // Register test providers
  Object.values(testProviders).forEach((provider) => {
    if (!registry.has(provider.id)) {
      registry.register(provider);
    }
  });

  await t.step("returns providers array with correct shape", async () => {
    const res = await app.request("/v1/summary");

    assertEquals(res.status, 200);
    const json = SummaryResponseSchema.parse(await res.json());

    // Should have at least our test providers
    const testProvider1 = json.providers.find((p) => p.id === testProviders.apikey1.id);
    assertExists(testProvider1);
    assertObjectMatch(testProvider1, {
      id: testProviders.apikey1.id,
      displayName: testProviders.apikey1.displayName,
      type: "apikey",
    });

    const testProvider2 = json.providers.find((p) => p.id === testProviders.apikey2.id);
    assertExists(testProvider2);
    assertObjectMatch(testProvider2, {
      id: testProviders.apikey2.id,
      displayName: testProviders.apikey2.displayName,
      type: "apikey",
    });
  });

  await t.step("returns credentials array (both oauth and apikey types)", async () => {
    // Create an apikey credential
    const apiKeyRes = await app.request("/v1/credentials/apikey", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: testProviders.apikey1.id,
        label: "Test API Key Credential",
        secret: { apiKey: "sk-test-123" },
      }),
    });
    assertEquals(apiKeyRes.status, 201);
    const apiKeyCreated = CredentialSummarySchema.parse(await apiKeyRes.json());

    // Fetch summary
    const res = await app.request("/v1/summary");
    assertEquals(res.status, 200);
    const json = SummaryResponseSchema.parse(await res.json());

    // Should have our credential
    const foundCred = json.credentials.find((c) => c.id === apiKeyCreated.id);
    assertExists(foundCred);
    assertObjectMatch(foundCred, {
      id: apiKeyCreated.id,
      type: "apikey",
      provider: testProviders.apikey1.id,
      label: "Test API Key Credential",
    });
  });

  await t.step("no secrets exposed in response", async () => {
    // Create credential with secret
    const secretData = { token: "very-secret-token-12345" };
    await app.request("/v1/credentials/apikey", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: testProviders.apikey2.id,
        label: "Secret Test",
        secret: secretData,
      }),
    });

    // Fetch summary
    const res = await app.request("/v1/summary");
    assertEquals(res.status, 200);
    const rawJson = await res.json();

    // Verify no secrets in raw JSON response
    const jsonString = JSON.stringify(rawJson);
    assertEquals(jsonString.includes("very-secret-token-12345"), false);
    assertEquals(jsonString.includes("sk-test-123"), false);

    // Verify credentials array doesn't have 'secret' field
    const json = SummaryResponseSchema.parse(rawJson);
    json.credentials.forEach((cred) => {
      assertEquals("secret" in cred, false);
    });
  });

  await t.step("empty arrays when no credentials exist", async () => {
    // Create new temp DB with no credentials
    const emptyTempDir = await Deno.makeTempDir();
    const emptyStorage = new DenoKVStorageAdapter(`${emptyTempDir}/kv.db`);
    const emptyOauthService = new OAuthService(registry, emptyStorage);
    const emptyApp = await createApp(
      emptyStorage,
      emptyOauthService,
      new NoOpPlatformRouteRepository(),
    );

    const res = await emptyApp.request("/v1/summary");
    assertEquals(res.status, 200);
    const json = SummaryResponseSchema.parse(await res.json());

    // Should still have providers (from registry)
    assertEquals(json.providers.length > 0, true);

    // But no credentials
    assertEquals(json.credentials.length, 0);

    await rm(emptyTempDir, { recursive: true });
  });

  await t.step("filters credentials by provider query param", async () => {
    // Create credentials for both test providers
    const apiKey1Res = await app.request("/v1/credentials/apikey", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: testProviders.apikey1.id,
        label: "Provider 1 Credential",
        secret: { apiKey: "sk-test-provider1" },
      }),
    });
    assertEquals(apiKey1Res.status, 201);
    const cred1 = CredentialSummarySchema.parse(await apiKey1Res.json());

    const apiKey2Res = await app.request("/v1/credentials/apikey", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: testProviders.apikey2.id,
        label: "Provider 2 Credential",
        secret: { token: "test-token-provider2" },
      }),
    });
    assertEquals(apiKey2Res.status, 201);
    const cred2 = CredentialSummarySchema.parse(await apiKey2Res.json());

    // Fetch summary without filter - should get both
    const allRes = await app.request("/v1/summary");
    assertEquals(allRes.status, 200);
    const allJson = SummaryResponseSchema.parse(await allRes.json());
    assertEquals(allJson.credentials.filter((c) => [cred1.id, cred2.id].includes(c.id)).length, 2);

    // Fetch summary filtered by provider 1
    const filtered1Res = await app.request(`/v1/summary?provider=${testProviders.apikey1.id}`);
    assertEquals(filtered1Res.status, 200);
    const filtered1Json = SummaryResponseSchema.parse(await filtered1Res.json());

    // Should only have provider 1 credentials
    const filtered1Creds = filtered1Json.credentials.filter((c) =>
      [cred1.id, cred2.id].includes(c.id),
    );
    assertEquals(filtered1Creds.length, 1);
    assertEquals(filtered1Creds[0]?.id, cred1.id);
    assertEquals(filtered1Creds[0]?.provider, testProviders.apikey1.id);

    // Fetch summary filtered by provider 2
    const filtered2Res = await app.request(`/v1/summary?provider=${testProviders.apikey2.id}`);
    assertEquals(filtered2Res.status, 200);
    const filtered2Json = SummaryResponseSchema.parse(await filtered2Res.json());

    // Should only have provider 2 credentials
    const filtered2Creds = filtered2Json.credentials.filter((c) =>
      [cred1.id, cred2.id].includes(c.id),
    );
    assertEquals(filtered2Creds.length, 1);
    assertEquals(filtered2Creds[0]?.id, cred2.id);
    assertEquals(filtered2Creds[0]?.provider, testProviders.apikey2.id);
  });

  await t.step("returns empty array for unknown provider (not 404)", async () => {
    const res = await app.request("/v1/summary?provider=nonexistent-provider-xyz");
    assertEquals(res.status, 200);
    const json = SummaryResponseSchema.parse(await res.json());

    // Should return empty credentials array, not 404
    assertEquals(json.credentials.length, 0);

    // Providers array should still include all registered providers
    assertEquals(json.providers.length > 0, true);
  });

  // Cleanup
  await rm(tempDir, { recursive: true });
});
