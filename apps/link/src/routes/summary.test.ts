import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

/** Helper to create a temp directory (replaces Deno.makeTempDir) */
async function makeTempDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "link-summary-test-"));
}

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
      displayName: z.string().nullable(),
      userIdentifier: z.string().nullable(),
      createdAt: z.string(),
      updatedAt: z.string(),
    }),
  ),
});

describe("GET /v1/summary endpoint", () => {
  let tempDir: string;
  let app: Awaited<ReturnType<typeof createApp>>;

  beforeAll(async () => {
    tempDir = await makeTempDir();
    const storage = new DenoKVStorageAdapter(`${tempDir}/kv.db`);
    const oauthService = new OAuthService(registry, storage);
    app = await createApp(storage, oauthService, new NoOpPlatformRouteRepository());

    // Register test providers
    Object.values(testProviders).forEach((provider) => {
      if (!registry.has(provider.id)) {
        registry.register(provider);
      }
    });
  });

  afterAll(async () => {
    await rm(tempDir, { recursive: true });
  });

  it("returns providers array with correct shape", async () => {
    const res = await app.request("/v1/summary");

    expect(res.status).toEqual(200);
    const json = SummaryResponseSchema.parse(await res.json());

    // Should have at least our test providers
    const testProvider1 = json.providers.find((p) => p.id === testProviders.apikey1.id);
    expect(testProvider1).toBeDefined();
    expect(testProvider1).toMatchObject({
      id: testProviders.apikey1.id,
      displayName: testProviders.apikey1.displayName,
      type: "apikey",
    });

    const testProvider2 = json.providers.find((p) => p.id === testProviders.apikey2.id);
    expect(testProvider2).toBeDefined();
    expect(testProvider2).toMatchObject({
      id: testProviders.apikey2.id,
      displayName: testProviders.apikey2.displayName,
      type: "apikey",
    });
  });

  it("returns credentials array (both oauth and apikey types)", async () => {
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
    expect(apiKeyRes.status).toEqual(201);
    const apiKeyCreated = CredentialSummarySchema.parse(await apiKeyRes.json());

    // Fetch summary
    const res = await app.request("/v1/summary");
    expect(res.status).toEqual(200);
    const json = SummaryResponseSchema.parse(await res.json());

    // Should have our credential
    const foundCred = json.credentials.find((c) => c.id === apiKeyCreated.id);
    expect(foundCred).toBeDefined();
    expect(foundCred).toMatchObject({
      id: apiKeyCreated.id,
      type: "apikey",
      provider: testProviders.apikey1.id,
      label: "Test API Key Credential",
    });
  });

  it("no secrets exposed in response", async () => {
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
    expect(res.status).toEqual(200);
    const rawJson = await res.json();

    // Verify no secrets in raw JSON response
    const jsonString = JSON.stringify(rawJson);
    expect(jsonString).not.toContain("very-secret-token-12345");
    expect(jsonString).not.toContain("sk-test-123");

    // Verify credentials array doesn't have 'secret' field
    const json = SummaryResponseSchema.parse(rawJson);
    json.credentials.forEach((cred) => {
      expect(cred).not.toHaveProperty("secret");
    });
  });

  it("empty arrays when no credentials exist", async () => {
    // Create new temp DB with no credentials
    const emptyTempDir = await makeTempDir();
    const emptyStorage = new DenoKVStorageAdapter(`${emptyTempDir}/kv.db`);
    const emptyOauthService = new OAuthService(registry, emptyStorage);
    const emptyApp = await createApp(
      emptyStorage,
      emptyOauthService,
      new NoOpPlatformRouteRepository(),
    );

    const res = await emptyApp.request("/v1/summary");
    expect(res.status).toEqual(200);
    const json = SummaryResponseSchema.parse(await res.json());

    // Should still have providers (from registry)
    expect(json.providers.length).toBeGreaterThan(0);

    // But no credentials
    expect(json.credentials).toHaveLength(0);

    await rm(emptyTempDir, { recursive: true });
  });

  it("filters credentials by provider query param", async () => {
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
    expect(apiKey1Res.status).toEqual(201);
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
    expect(apiKey2Res.status).toEqual(201);
    const cred2 = CredentialSummarySchema.parse(await apiKey2Res.json());

    // Fetch summary without filter - should get both
    const allRes = await app.request("/v1/summary");
    expect(allRes.status).toEqual(200);
    const allJson = SummaryResponseSchema.parse(await allRes.json());
    expect(allJson.credentials.filter((c) => [cred1.id, cred2.id].includes(c.id))).toHaveLength(2);

    // Fetch summary filtered by provider 1
    const filtered1Res = await app.request(`/v1/summary?provider=${testProviders.apikey1.id}`);
    expect(filtered1Res.status).toEqual(200);
    const filtered1Json = SummaryResponseSchema.parse(await filtered1Res.json());

    // Should only have provider 1 credentials
    const filtered1Creds = filtered1Json.credentials.filter((c) =>
      [cred1.id, cred2.id].includes(c.id),
    );
    expect(filtered1Creds).toHaveLength(1);
    expect(filtered1Creds[0]).toMatchObject({ id: cred1.id, provider: testProviders.apikey1.id });

    // Fetch summary filtered by provider 2
    const filtered2Res = await app.request(`/v1/summary?provider=${testProviders.apikey2.id}`);
    expect(filtered2Res.status).toEqual(200);
    const filtered2Json = SummaryResponseSchema.parse(await filtered2Res.json());

    // Should only have provider 2 credentials
    const filtered2Creds = filtered2Json.credentials.filter((c) =>
      [cred1.id, cred2.id].includes(c.id),
    );
    expect(filtered2Creds).toHaveLength(1);
    expect(filtered2Creds[0]).toMatchObject({ id: cred2.id, provider: testProviders.apikey2.id });
  });

  it("returns empty array for unknown provider (not 404)", async () => {
    const res = await app.request("/v1/summary?provider=nonexistent-provider-xyz");
    expect(res.status).toEqual(200);
    const json = SummaryResponseSchema.parse(await res.json());

    // Should return empty credentials array, not 404
    expect(json.credentials).toHaveLength(0);

    // Providers array should still include all registered providers
    expect(json.providers.length).toBeGreaterThan(0);
  });

  it("credentials include displayName, userIdentifier, and updatedAt fields", async () => {
    // Create credential
    const createRes = await app.request("/v1/credentials/apikey", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: testProviders.apikey1.id,
        label: "Fields Test",
        secret: { apiKey: "sk-fields-test" },
      }),
    });
    expect(createRes.status).toEqual(201);
    const created = CredentialSummarySchema.parse(await createRes.json());

    // Update displayName
    const patchRes = await app.request(`/v1/credentials/${created.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ displayName: "My Custom Name" }),
    });
    expect(patchRes.status).toEqual(200);

    // Fetch summary
    const res = await app.request("/v1/summary");
    expect(res.status).toEqual(200);
    const json = SummaryResponseSchema.parse(await res.json());

    // Find our credential
    const cred = json.credentials.find((c) => c.id === created.id);
    expect(cred).toBeDefined();
    expect(cred).toMatchObject({
      displayName: "My Custom Name",
      userIdentifier: null, // apikey doesn't have userIdentifier
    });
    expect(cred!.createdAt).toBeDefined();
    expect(cred!.updatedAt).toBeDefined();
  });
});
