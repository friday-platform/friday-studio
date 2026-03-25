import { rm } from "node:fs/promises";
import { makeTempDir } from "@atlas/utils/temp.server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { FileSystemStorageAdapter } from "../src/adapters/filesystem-adapter.ts";
import { NoOpPlatformRouteRepository } from "../src/adapters/platform-route-repository.ts";
import { NoOpSlackAppWorkspaceRepository } from "../src/adapters/slack-app-workspace-repository.ts";
import { NoOpWebhookSecretRepository } from "../src/adapters/webhook-secret-repository.ts";
import { createApp } from "../src/index.ts";
import { OAuthService } from "../src/oauth/service.ts";
import { registry } from "../src/providers/registry.ts";
import { CredentialSchema, CredentialSummarySchema } from "../src/types.ts";

const ErrorResponse = z.looseObject({
  error: z.string(),
  message: z.string().optional(),
  issues: z.array(z.unknown()).optional(),
});

const testProviders = {
  // Basic providers - minimal schema, no health check
  basic: {
    id: "test-create",
    type: "apikey" as const,
    displayName: "Test Create",
    description: "Test provider for creation",
    setupInstructions: "# Test",
    secretSchema: z.object({ apiKey: z.string() }),
  },
  basicGet: {
    id: "test-get",
    type: "apikey" as const,
    displayName: "Test Get",
    description: "Test provider for get",
    setupInstructions: "# Test",
    secretSchema: z.object({ key: z.string() }),
  },
  basicDelete: {
    id: "test-delete",
    type: "apikey" as const,
    displayName: "Test Delete",
    description: "Test provider for delete",
    setupInstructions: "# Test",
    secretSchema: z.object({}),
  },
  basicInternal: {
    id: "test-internal",
    type: "apikey" as const,
    displayName: "Test Internal",
    description: "Test provider for internal",
    setupInstructions: "# Test",
    secretSchema: z.object({ apiKey: z.string() }),
  },
  // Validation - strict schema enforcement
  validation: {
    id: "test-validation",
    type: "apikey" as const,
    displayName: "Test Validation",
    description: "Test provider with validation",
    setupInstructions: "# Test",
    secretSchema: z.object({
      token: z.string().regex(/^xoxb-/, "Invalid token format. Must start with xoxb-"),
      workspace: z.string().min(1, "Workspace is required"),
    }),
  },
  validSchema: {
    id: "test-valid-schema",
    type: "apikey" as const,
    displayName: "Test Valid Schema",
    description: "Test provider with valid schema",
    setupInstructions: "# Test",
    secretSchema: z.object({ apiKey: z.string().min(10), endpoint: z.url().optional() }),
  },

  // Health checks - various health check behaviors
  unhealthy: {
    id: "test-unhealthy",
    type: "apikey" as const,
    displayName: "Test Unhealthy",
    description: "Test provider with unhealthy health check",
    setupInstructions: "# Test Provider",
    secretSchema: z.object({ token: z.string() }),
    health: () => Promise.resolve({ healthy: false as const, error: "token_revoked" }),
  },
  // Full details - providers with all optional fields
  fullDetails: {
    id: "test-provider-detail",
    type: "apikey" as const,
    displayName: "Test Provider Detail",
    description: "A test provider for detail view",
    setupInstructions: "# Setup Instructions\n\n1. Go to provider\n2. Create API key",
    secretSchema: z.object({ apiKey: z.string(), workspace: z.string().optional() }),
    iconUrl: "https://example.com/icon.png",
    docsUrl: "https://example.com/docs",
    health: () => Promise.resolve({ healthy: true as const }),
  },
  fullDetailsNoHealth: {
    id: "test-provider-no-health-detail",
    type: "apikey" as const,
    displayName: "Test No Health Detail",
    description: "A test provider without health",
    setupInstructions: "# Setup",
    secretSchema: z.object({ token: z.string() }),
  },
  basicDefault: {
    id: "test-default",
    type: "apikey" as const,
    displayName: "Test Default",
    description: "Test provider for default endpoint",
    setupInstructions: "# Test",
    secretSchema: z.object({ key: z.string() }),
  },
  internalDefault: {
    id: "test-internal-default",
    type: "apikey" as const,
    displayName: "Test Internal Default",
    description: "Test provider for internal default endpoint",
    setupInstructions: "# Test",
    secretSchema: z.object({ apiKey: z.string() }),
  },
  listProvider: {
    id: "test-provider-list",
    type: "apikey" as const,
    displayName: "Test Provider",
    description: "A test provider for listing",
    setupInstructions: "# Setup",
    secretSchema: z.object({ key: z.string() }),
    iconUrl: "https://example.com/icon.png",
    docsUrl: "https://example.com/docs",
  },
} as const;

describe("Link HTTP routes", () => {
  let tempDir: string;
  let storage: FileSystemStorageAdapter;
  let app: Awaited<ReturnType<typeof createApp>>;

  beforeAll(async () => {
    tempDir = makeTempDir();
    storage = new FileSystemStorageAdapter(tempDir);
    const oauthService = new OAuthService(registry, storage);
    app = await createApp(
      storage,
      oauthService,
      new NoOpPlatformRouteRepository(),
      new NoOpWebhookSecretRepository(),
      new NoOpSlackAppWorkspaceRepository(),
    );

    // Register all test providers once at setup
    Object.values(testProviders).forEach((provider) => {
      if (!registry.has(provider.id)) {
        registry.register(provider);
      }
    });
  });

  afterAll(async () => {
    await rm(tempDir, { recursive: true });
  });

  it("PUT /v1/credentials/:type creates credential", async () => {
    const res = await app.request("/v1/credentials/apikey", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: testProviders.basic.id,
        label: "Test Key",
        secret: { apiKey: "sk-test-123" },
      }),
    });

    expect(res.status).toBe(201);
    const json = CredentialSummarySchema.parse(await res.json());
    expect(json).toMatchObject({
      type: "apikey",
      provider: testProviders.basic.id,
      label: "Test Key",
    });
  });

  it("PUT /v1/credentials/:type rejects unknown provider", async () => {
    const res = await app.request("/v1/credentials/apikey", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "nonexistent-provider",
        label: "Test Key",
        secret: { apiKey: "sk-test-123" },
      }),
    });

    expect(res.status).toBe(400);
    const json = ErrorResponse.parse(await res.json());
    expect(json).toMatchObject({ error: "unknown_provider" });
    expect.assert(json.message !== undefined, "message should be defined");
    expect(json.message).toMatch(/nonexistent-provider/);
  });

  it("PUT /v1/credentials/:type rejects invalid secret schema", async () => {
    const res = await app.request("/v1/credentials/apikey", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: testProviders.validation.id,
        label: "Invalid Secret",
        secret: { token: "invalid-token", workspace: "" },
      }),
    });

    expect(res.status).toBe(400);
    const json = ErrorResponse.parse(await res.json());
    expect(json).toMatchObject({
      error: "validation_failed",
      provider: testProviders.validation.id,
    });
    expect.assert(json.issues !== undefined, "issues should be defined");
    expect(json.issues.length).toBeGreaterThan(0);
  });

  it("PUT /v1/credentials/:type accepts valid secret matching schema", async () => {
    const res = await app.request("/v1/credentials/apikey", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: testProviders.validSchema.id,
        label: "Valid Secret",
        secret: { apiKey: "sk-valid-1234567890", endpoint: "https://api.example.com" },
      }),
    });

    expect(res.status).toBe(201);
    const json = CredentialSummarySchema.parse(await res.json());
    expect(json).toMatchObject({
      type: "apikey",
      provider: testProviders.validSchema.id,
      label: "Valid Secret",
    });
  });

  it("GET /v1/credentials/type/:type lists credentials", async () => {
    const res = await app.request("/v1/credentials/type/apikey");

    expect(res.status).toBe(200);
    const json = z.array(CredentialSummarySchema).parse(await res.json());
    expect(json.length).toBeGreaterThan(0);
  });

  it("GET /v1/credentials/:id returns metadata without secret", async () => {
    // Create
    const createRes = await app.request("/v1/credentials/apikey", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: testProviders.basicGet.id,
        label: "GetTest",
        secret: { key: "value" },
      }),
    });
    const created = CredentialSummarySchema.parse(await createRes.json());

    // Fetch
    const res = await app.request(`/v1/credentials/${created.id}`);

    expect(res.status).toBe(200);
    const json = CredentialSummarySchema.parse(await res.json());
    expect(json.id).toBe(created.id);
  });

  it("GET /v1/credentials/:id returns 404 for missing", async () => {
    const res = await app.request("/v1/credentials/nonexistent-id");

    expect(res.status).toBe(404);
    const json = ErrorResponse.parse(await res.json());
    expect(json.error).toMatch(/not found/i);
  });

  it("DELETE /v1/credentials/:id removes credential", async () => {
    // Create
    const createRes = await app.request("/v1/credentials/apikey", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: testProviders.basicDelete.id,
        label: "DeleteTest",
        secret: {},
      }),
    });
    const created = CredentialSummarySchema.parse(await createRes.json());

    // Delete
    const deleteRes = await app.request(`/v1/credentials/${created.id}`, { method: "DELETE" });
    expect(deleteRes.status).toBe(204);

    // Verify gone
    const getRes = await app.request(`/v1/credentials/${created.id}`);
    expect(getRes.status).toBe(404);
  });

  it("GET /internal/v1/credentials/:id returns full credential with secret", async () => {
    const secretData = { apiKey: "sk-secret-value" };
    const createRes = await app.request("/v1/credentials/apikey", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: testProviders.basicInternal.id,
        label: "InternalTest",
        secret: secretData,
      }),
    });
    const created = CredentialSummarySchema.parse(await createRes.json());

    const res = await app.request(`/internal/v1/credentials/${created.id}`);

    expect(res.status).toBe(200);
    const json = z
      .object({
        credential: CredentialSchema,
        status: z.enum(["ready", "refreshed", "expired_no_refresh", "refresh_failed"]),
        error: z.string().optional(),
      })
      .parse(await res.json());
    expect(json.status).toBe("ready");
    expect(json.credential.secret.apiKey).toBe(secretData.apiKey);
  });

  it("PUT /v1/credentials/:type rejects credential with failed health check", async () => {
    // Attempt to create credential with unhealthy provider
    const createRes = await app.request("/v1/credentials/apikey", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: testProviders.unhealthy.id,
        label: "Unhealthy Test Cred",
        secret: { token: "xoxb-test-token" },
      }),
    });

    // Should be rejected with health_check_failed
    expect(createRes.status).toBe(400);
    const body = ErrorResponse.parse(await createRes.json());
    expect(body).toMatchObject({
      error: "health_check_failed",
      message: "token_revoked",
      provider: testProviders.unhealthy.id,
    });
  });

  it("GET /v1/providers returns list of registered providers", async () => {
    const res = await app.request("/v1/providers");

    expect(res.status).toBe(200);
    const json = z
      .object({
        providers: z.array(
          z.object({
            id: z.string(),
            displayName: z.string(),
            description: z.string(),
            iconUrl: z.string().nullable(),
            docsUrl: z.string().nullable(),
          }),
        ),
      })
      .parse(await res.json());

    // Should have at least our test provider
    expect(json.providers.length).toBeGreaterThan(0);

    // Find our test provider
    const testProvider = json.providers.find((p) => p.id === testProviders.listProvider.id);
    expect.assert(testProvider !== undefined, "test provider should be found");
    expect(testProvider).toMatchObject({
      displayName: "Test Provider",
      description: "A test provider for listing",
      iconUrl: "https://example.com/icon.png",
      docsUrl: "https://example.com/docs",
    });
  });

  it("GET /v1/providers does not leak setupInstructions or secretSchema", async () => {
    const res = await app.request("/v1/providers");

    expect(res.status).toBe(200);
    const rawJson = await res.json();

    // Check that the raw JSON doesn't contain setup instructions or schema
    const jsonString = JSON.stringify(rawJson);
    expect(jsonString).not.toContain("setupInstructions");
    expect(jsonString).not.toContain("secretSchema");
  });

  it("GET /v1/providers/:id returns full provider details", async () => {
    const res = await app.request(`/v1/providers/${testProviders.fullDetails.id}`);

    expect(res.status).toBe(200);
    const json = z
      .object({
        id: z.string(),
        displayName: z.string(),
        description: z.string(),
        iconUrl: z.string().nullable(),
        docsUrl: z.string().nullable(),
        setupInstructions: z.string(),
        secretSchema: z.unknown(),
        supportsHealth: z.boolean(),
      })
      .parse(await res.json());

    expect(json.id).toBe(testProviders.fullDetails.id);
    expect(json.displayName).toBe("Test Provider Detail");
    expect(json.description).toBe("A test provider for detail view");
    expect(json.iconUrl).toBe("https://example.com/icon.png");
    expect(json.docsUrl).toBe("https://example.com/docs");
    expect(json.setupInstructions).toBe(
      "# Setup Instructions\n\n1. Go to provider\n2. Create API key",
    );
    expect(json.supportsHealth).toBe(true);

    // Verify secretSchema is valid JSON Schema
    expect.assert(
      typeof json.secretSchema === "object" && json.secretSchema !== null,
      "secretSchema should be an object",
    );
    expect(json.secretSchema).toHaveProperty("type", "object");
    expect(json.secretSchema).toHaveProperty("properties");
  });

  it("GET /v1/providers/:id returns 404 for unknown provider", async () => {
    const res = await app.request("/v1/providers/nonexistent-provider");

    expect(res.status).toBe(404);
    const json = ErrorResponse.parse(await res.json());
    expect(json).toMatchObject({ error: "provider_not_found" });
    expect.assert(json.message !== undefined, "message should be defined");
    expect(json.message).toMatch(/nonexistent-provider/);
  });

  it("GET /v1/providers/:id supportsHealth is false when no health function", async () => {
    const res = await app.request(`/v1/providers/${testProviders.fullDetailsNoHealth.id}`);

    expect(res.status).toBe(200);
    const json = z.object({ id: z.string(), supportsHealth: z.boolean() }).parse(await res.json());
    expect(json.id).toBe(testProviders.fullDetailsNoHealth.id);
    expect(json.supportsHealth).toBe(false);
  });

  it("PATCH /v1/credentials/:id updates displayName", async () => {
    // Create credential
    const createRes = await app.request("/v1/credentials/apikey", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: testProviders.basicGet.id,
        label: "PatchTest",
        secret: { key: "value" },
      }),
    });
    const created = CredentialSummarySchema.parse(await createRes.json());

    // Patch displayName
    const patchRes = await app.request(`/v1/credentials/${created.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ displayName: "My Custom Name" }),
    });

    expect(patchRes.status).toBe(200);
    const patched = CredentialSummarySchema.parse(await patchRes.json());
    expect(patched.id).toBe(created.id);
    expect(patched.displayName).toBe("My Custom Name");

    // Verify persisted via GET
    const getRes = await app.request(`/v1/credentials/${created.id}`);
    const fetched = CredentialSummarySchema.parse(await getRes.json());
    expect(fetched.displayName).toBe("My Custom Name");
  });

  it("PATCH /v1/credentials/:id validates displayName (1-100 chars, trimmed)", async () => {
    // Create credential
    const createRes = await app.request("/v1/credentials/apikey", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: testProviders.basicGet.id,
        label: "ValidationTest",
        secret: { key: "value" },
      }),
    });
    const created = CredentialSummarySchema.parse(await createRes.json());

    // Empty string after trim should fail
    const emptyRes = await app.request(`/v1/credentials/${created.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ displayName: "   " }),
    });
    expect(emptyRes.status).toBe(400);

    // Too long (>100 chars) should fail
    const longRes = await app.request(`/v1/credentials/${created.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ displayName: "a".repeat(101) }),
    });
    expect(longRes.status).toBe(400);

    // Valid name with whitespace should be trimmed
    const validRes = await app.request(`/v1/credentials/${created.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ displayName: "  Trimmed Name  " }),
    });
    expect(validRes.status).toBe(200);
    const patched = CredentialSummarySchema.parse(await validRes.json());
    expect(patched.displayName).toBe("Trimmed Name");
  });

  it("PATCH /v1/credentials/:id returns 404 for non-existent credential", async () => {
    const res = await app.request("/v1/credentials/nonexistent-id", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ displayName: "Test" }),
    });

    expect(res.status).toBe(404);
    const json = ErrorResponse.parse(await res.json());
    expect(json.error).toMatch(/not found/i);
  });

  it("PATCH /v1/credentials/:id/default sets credential as default", async () => {
    // Create two credentials for the same provider
    const res1 = await app.request("/v1/credentials/apikey", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: testProviders.basicDefault.id,
        label: "DefaultTest-First",
        secret: { key: "first" },
      }),
    });
    const first = CredentialSummarySchema.parse(await res1.json());

    const res2 = await app.request("/v1/credentials/apikey", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: testProviders.basicDefault.id,
        label: "DefaultTest-Second",
        secret: { key: "second" },
      }),
    });
    const second = CredentialSummarySchema.parse(await res2.json());

    // Explicitly set first as default
    await app.request(`/v1/credentials/${first.id}/default`, { method: "PATCH" });

    // Swap: set second as default
    const patchRes = await app.request(`/v1/credentials/${second.id}/default`, { method: "PATCH" });
    expect(patchRes.status).toBe(200);

    // Verify second is now default
    const getSecond = await app.request(`/v1/credentials/${second.id}`);
    const secondAfter = CredentialSummarySchema.parse(await getSecond.json());
    expect(secondAfter.isDefault).toBe(true);

    // Verify first is no longer default
    const getFirst = await app.request(`/v1/credentials/${first.id}`);
    const firstAfter = CredentialSummarySchema.parse(await getFirst.json());
    expect(firstAfter.isDefault).toBe(false);
  });

  it("PATCH /v1/credentials/:id/default returns 200 when already default", async () => {
    // Create a credential with a unique provider for this test
    const createRes = await app.request("/v1/credentials/apikey", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: testProviders.basicDefault.id,
        label: "AlreadyDefault",
        secret: { key: "val" },
      }),
    });
    const created = CredentialSummarySchema.parse(await createRes.json());

    // Explicitly set as default to guarantee state
    await app.request(`/v1/credentials/${created.id}/default`, { method: "PATCH" });

    // Set as default again — should be 200 no-op
    const patchRes = await app.request(`/v1/credentials/${created.id}/default`, {
      method: "PATCH",
    });
    expect(patchRes.status).toBe(200);
  });

  it("PATCH /v1/credentials/:id/default returns 404 for non-existent credential", async () => {
    const res = await app.request("/v1/credentials/nonexistent-id/default", { method: "PATCH" });

    expect(res.status).toBe(404);
    const json = ErrorResponse.parse(await res.json());
    expect(json.error).toMatch(/not found/i);
  });

  it("PATCH /v1/credentials/:id/default returns 404 for soft-deleted credential", async () => {
    // Create and delete
    const createRes = await app.request("/v1/credentials/apikey", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: testProviders.basicDelete.id,
        label: "SoftDeleteDefault",
        secret: {},
      }),
    });
    const created = CredentialSummarySchema.parse(await createRes.json());

    await app.request(`/v1/credentials/${created.id}`, { method: "DELETE" });

    // Try to set as default
    const patchRes = await app.request(`/v1/credentials/${created.id}/default`, {
      method: "PATCH",
    });
    expect(patchRes.status).toBe(404);
    const json = ErrorResponse.parse(await patchRes.json());
    expect(json.error).toMatch(/not found/i);
  });

  it("GET /internal/v1/credentials/default/:provider returns default credential with secrets", async () => {
    const secretData = { apiKey: "sk-internal-default-secret" };

    // Create credential and set as default
    const createRes = await app.request("/v1/credentials/apikey", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: testProviders.internalDefault.id,
        label: "InternalDefaultTest",
        secret: secretData,
      }),
    });
    const created = CredentialSummarySchema.parse(await createRes.json());
    await app.request(`/v1/credentials/${created.id}/default`, { method: "PATCH" });

    // Fetch default by provider
    const res = await app.request(
      `/internal/v1/credentials/default/${testProviders.internalDefault.id}`,
    );

    expect(res.status).toBe(200);
    const json = z
      .object({
        credential: CredentialSchema,
        status: z.enum(["ready", "refreshed", "expired_no_refresh", "refresh_failed"]),
        error: z.string().optional(),
      })
      .parse(await res.json());
    expect(json.status).toBe("ready");
    expect(json.credential.secret.apiKey).toBe(secretData.apiKey);
    expect(json.credential.provider).toBe(testProviders.internalDefault.id);
  });

  it("GET /internal/v1/credentials/default/:provider returns 404 when no default exists", async () => {
    const res = await app.request("/internal/v1/credentials/default/nonexistent-provider");

    expect(res.status).toBe(404);
    const json = ErrorResponse.parse(await res.json());
    expect(json.error).toBe("no_default_credential");
  });
});
