import { assert, assertEquals, assertExists, assertMatch, assertObjectMatch } from "@std/assert";
import { z } from "zod";
import { DenoKVStorageAdapter } from "../src/adapters/deno-kv-adapter.ts";
import { createApp } from "../src/index.ts";
import { OAuthService } from "../src/oauth/service.ts";
import { registry } from "../src/providers/registry.ts";
import { CredentialSchema, CredentialSummarySchema } from "../src/types.ts";

/** Schema for error responses - allows partial matching with assertObjectMatch */
const ErrorResponse = z.looseObject({
  error: z.string(),
  message: z.string().optional(),
  issues: z.array(z.unknown()).optional(),
});

/**
 * Shared test provider fixtures grouped by capability.
 * Registered once at test setup, referenced by key in individual tests.
 */
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

Deno.test("Link HTTP routes", async (t) => {
  const tempDir = await Deno.makeTempDir();
  const storage = new DenoKVStorageAdapter(`${tempDir}/kv.db`);
  const oauthService = new OAuthService(registry, storage);
  const app = await createApp(storage, oauthService);

  // Register all test providers once at setup
  Object.values(testProviders).forEach((provider) => {
    if (!registry.has(provider.id)) {
      registry.register(provider);
    }
  });

  await t.step("PUT /v1/credentials/:type creates credential", async () => {
    const res = await app.request("/v1/credentials/apikey", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: testProviders.basic.id,
        label: "Test Key",
        secret: { apiKey: "sk-test-123" },
      }),
    });

    assertEquals(res.status, 201);
    const json = CredentialSummarySchema.parse(await res.json());
    assertObjectMatch(json, {
      type: "apikey",
      provider: testProviders.basic.id,
      label: "Test Key",
    });
  });

  await t.step("PUT /v1/credentials/:type rejects unknown provider", async () => {
    const res = await app.request("/v1/credentials/apikey", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "nonexistent-provider",
        label: "Test Key",
        secret: { apiKey: "sk-test-123" },
      }),
    });

    assertEquals(res.status, 400);
    const json = ErrorResponse.parse(await res.json());
    assertObjectMatch(json, { error: "unknown_provider" });
    assertExists(json.message);
    assertMatch(json.message, /nonexistent-provider/);
  });

  await t.step("PUT /v1/credentials/:type rejects invalid secret schema", async () => {
    const res = await app.request("/v1/credentials/apikey", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: testProviders.validation.id,
        label: "Invalid Secret",
        secret: { token: "invalid-token", workspace: "" },
      }),
    });

    assertEquals(res.status, 400);
    const json = ErrorResponse.parse(await res.json());
    assertObjectMatch(json, { error: "validation_failed", provider: testProviders.validation.id });
    assertExists(json.issues);
    assert(json.issues.length > 0);
  });

  await t.step("PUT /v1/credentials/:type accepts valid secret matching schema", async () => {
    const res = await app.request("/v1/credentials/apikey", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: testProviders.validSchema.id,
        label: "Valid Secret",
        secret: { apiKey: "sk-valid-1234567890", endpoint: "https://api.example.com" },
      }),
    });

    assertEquals(res.status, 201);
    const json = CredentialSummarySchema.parse(await res.json());
    assertObjectMatch(json, {
      type: "apikey",
      provider: testProviders.validSchema.id,
      label: "Valid Secret",
    });
  });

  await t.step("GET /v1/credentials/type/:type lists credentials", async () => {
    const res = await app.request("/v1/credentials/type/apikey");

    assertEquals(res.status, 200);
    const json = z.array(CredentialSummarySchema).parse(await res.json());
    assert(json.length > 0);
  });

  await t.step("GET /v1/credentials/:id returns metadata without secret", async () => {
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

    assertEquals(res.status, 200);
    const json = CredentialSummarySchema.parse(await res.json());
    assertEquals(json.id, created.id);
  });

  await t.step("GET /v1/credentials/:id returns 404 for missing", async () => {
    const res = await app.request("/v1/credentials/nonexistent-id");

    assertEquals(res.status, 404);
    const json = ErrorResponse.parse(await res.json());
    assertMatch(json.error, /not found/i);
  });

  await t.step("DELETE /v1/credentials/:id removes credential", async () => {
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
    assertEquals(deleteRes.status, 204);

    // Verify gone
    const getRes = await app.request(`/v1/credentials/${created.id}`);
    assertEquals(getRes.status, 404);
  });

  await t.step("GET /internal/v1/credentials/:id returns full credential with secret", async () => {
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

    assertEquals(res.status, 200);
    const json = z
      .object({
        credential: CredentialSchema,
        status: z.enum(["ready", "refreshed", "expired_no_refresh", "refresh_failed"]),
        error: z.string().optional(),
      })
      .parse(await res.json());
    assertEquals(json.status, "ready");
    assertEquals(json.credential.secret.apiKey, secretData.apiKey);
  });

  await t.step(
    "PUT /v1/credentials/:type rejects credential with failed health check",
    async () => {
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
      assertEquals(createRes.status, 400);
      const body = ErrorResponse.parse(await createRes.json());
      assertObjectMatch(body, {
        error: "health_check_failed",
        message: "token_revoked",
        provider: testProviders.unhealthy.id,
      });
    },
  );

  await t.step("GET /v1/providers returns list of registered providers", async () => {
    const res = await app.request("/v1/providers");

    assertEquals(res.status, 200);
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
    assert(json.providers.length > 0);

    // Find our test provider
    const testProvider = json.providers.find((p) => p.id === testProviders.listProvider.id);
    assertExists(testProvider);
    assertObjectMatch(testProvider, {
      displayName: "Test Provider",
      description: "A test provider for listing",
      iconUrl: "https://example.com/icon.png",
      docsUrl: "https://example.com/docs",
    });
  });

  await t.step("GET /v1/providers does not leak setupInstructions or secretSchema", async () => {
    const res = await app.request("/v1/providers");

    assertEquals(res.status, 200);
    const rawJson = await res.json();

    // Check that the raw JSON doesn't contain setup instructions or schema
    const jsonString = JSON.stringify(rawJson);
    assert(!jsonString.includes("setupInstructions"));
    assert(!jsonString.includes("secretSchema"));
  });

  await t.step("GET /v1/providers/:id returns full provider details", async () => {
    const res = await app.request(`/v1/providers/${testProviders.fullDetails.id}`);

    assertEquals(res.status, 200);
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

    assertEquals(json.id, testProviders.fullDetails.id);
    assertEquals(json.displayName, "Test Provider Detail");
    assertEquals(json.description, "A test provider for detail view");
    assertEquals(json.iconUrl, "https://example.com/icon.png");
    assertEquals(json.docsUrl, "https://example.com/docs");
    assertEquals(
      json.setupInstructions,
      "# Setup Instructions\n\n1. Go to provider\n2. Create API key",
    );
    assertEquals(json.supportsHealth, true);

    // Verify secretSchema is valid JSON Schema - just check structure manually
    assert(typeof json.secretSchema === "object" && json.secretSchema !== null);
    const schema = json.secretSchema as Record<string, unknown>;
    assertEquals(schema.type, "object");
    assert(typeof schema.properties === "object" && schema.properties !== null);
  });

  await t.step("GET /v1/providers/:id returns 404 for unknown provider", async () => {
    const res = await app.request("/v1/providers/nonexistent-provider");

    assertEquals(res.status, 404);
    const json = ErrorResponse.parse(await res.json());
    assertObjectMatch(json, { error: "provider_not_found" });
    assertExists(json.message);
    assertMatch(json.message, /nonexistent-provider/);
  });

  await t.step(
    "GET /v1/providers/:id supportsHealth is false when no health function",
    async () => {
      const res = await app.request(`/v1/providers/${testProviders.fullDetailsNoHealth.id}`);

      assertEquals(res.status, 200);
      const json = z
        .object({ id: z.string(), supportsHealth: z.boolean() })
        .parse(await res.json());
      assertEquals(json.id, testProviders.fullDetailsNoHealth.id);
      assertEquals(json.supportsHealth, false);
    },
  );

  // Cleanup
  await Deno.remove(tempDir, { recursive: true });
});
