/**
 * App Install Routes Integration Tests
 * Tests HTTP endpoints with real routes and mocked services
 */

import { assertEquals, assertExists, assertMatch } from "@std/assert";
import { beforeEach, describe, it } from "@std/testing/bdd";
import { z } from "zod";
import type { PlatformRouteRepository } from "../adapters/platform-route-repository.ts";
import { AppInstallService } from "../app-install/service.ts";
import { factory } from "../factory.ts";
import { defineAppInstallProvider, type ProviderDefinition } from "../providers/types.ts";
import type { Credential, CredentialInput, SaveResult, StorageAdapter } from "../types.ts";
import { createAppInstallRoutes } from "./app-install.ts";

/** Response schemas for type-safe test assertions */
const ErrorResponseSchema = z.object({
  error: z.string(),
  message: z.string().optional(),
  status: z.string().optional(),
  error_description: z.string().optional(),
});
const SuccessResponseSchema = z.object({
  status: z.string(),
  provider: z.string(),
  credential_id: z.string(),
});

/**
 * Mock implementations
 */

/** Mock provider registry - only needs get() for service */
class MockProviderRegistry {
  private providers = new Map<string, ProviderDefinition>();

  register(provider: ProviderDefinition) {
    this.providers.set(provider.id, provider);
  }

  get(id: string): ProviderDefinition | undefined {
    return this.providers.get(id);
  }
}

class MockStorageAdapter implements StorageAdapter {
  private credentials = new Map<string, Credential>();
  private idCounter = 0;

  save(input: CredentialInput, _userId: string): Promise<SaveResult> {
    const id = `cred-${++this.idCounter}`;
    const credential: Credential = {
      id,
      ...input,
      metadata: { createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
    };
    this.credentials.set(id, credential);
    return Promise.resolve({ id, metadata: credential.metadata });
  }

  update(id: string, input: CredentialInput, _userId: string) {
    const existing = this.credentials.get(id);
    if (!existing) return Promise.reject(new Error("Credential not found"));
    const updated: Credential = {
      ...existing,
      ...input,
      id,
      metadata: { ...existing.metadata, updatedAt: new Date().toISOString() },
    };
    this.credentials.set(id, updated);
    return Promise.resolve(updated.metadata);
  }

  get(id: string, _userId: string): Promise<Credential | null> {
    return Promise.resolve(this.credentials.get(id) ?? null);
  }

  list(_type: string, _userId: string) {
    return Promise.resolve(
      Array.from(this.credentials.values()).map((c) => ({
        id: c.id,
        type: c.type,
        provider: c.provider,
        label: c.label,
        metadata: c.metadata,
      })),
    );
  }

  delete(id: string, _userId: string) {
    this.credentials.delete(id);
    return Promise.resolve();
  }

  upsert(input: CredentialInput, userId: string): Promise<SaveResult> {
    // Find existing by provider + label + userId
    for (const [id, cred] of this.credentials.entries()) {
      if (cred.provider === input.provider && cred.label === input.label) {
        // Update existing
        const updated: Credential = {
          ...cred,
          ...input,
          id,
          metadata: { ...cred.metadata, updatedAt: new Date().toISOString() },
        };
        this.credentials.set(id, updated);
        return Promise.resolve({ id, metadata: updated.metadata });
      }
    }
    // Create new
    return this.save(input, userId);
  }

  findByProviderAndExternalId(
    provider: string,
    externalId: string,
    _userId: string,
  ): Promise<Credential | null> {
    for (const cred of this.credentials.values()) {
      if (cred.provider === provider) {
        const secret = cred.secret as { externalId?: string };
        if (secret.externalId === externalId) {
          return Promise.resolve(cred);
        }
      }
    }
    return Promise.resolve(null);
  }
}

class MockPlatformRouteRepository implements PlatformRouteRepository {
  private routes = new Map<string, string>();

  upsert(teamId: string, userId: string): Promise<void> {
    this.routes.set(teamId, userId);
    return Promise.resolve();
  }
}

describe("App Install Routes", () => {
  let registry: MockProviderRegistry;
  let storage: MockStorageAdapter;
  let routeStorage: MockPlatformRouteRepository;
  let service: AppInstallService;
  let app: ReturnType<typeof factory.createApp>;

  const mockProvider = defineAppInstallProvider({
    id: "test-slack",
    platform: "slack",
    displayName: "Test Slack",
    description: "Test provider",
    buildAuthorizationUrl(callbackUrl, state) {
      return `https://slack.com/oauth/v2/authorize?state=${state}&redirect_uri=${encodeURIComponent(callbackUrl)}`;
    },
    completeInstallation(code, _callbackUrl) {
      if (code === "error-code") {
        return Promise.reject(new Error("Installation failed"));
      }
      return Promise.resolve({
        externalId: `team-${code}`,
        externalName: "Test Workspace",
        credential: {
          type: "oauth",
          provider: "test-slack",
          label: "Test Workspace",
          secret: { externalId: `team-${code}`, access_token: `xoxb-${code}`, token_type: "bot" },
        },
      });
    },
  });

  beforeEach(() => {
    registry = new MockProviderRegistry();
    storage = new MockStorageAdapter();
    routeStorage = new MockPlatformRouteRepository();
    service = new AppInstallService(registry, storage, routeStorage, "https://link.example.com");

    // Register mock provider
    registry.register(mockProvider);

    // Create app with routes
    app = factory.createApp().route("/v1/app-install", createAppInstallRoutes(service));
  });

  describe("GET /v1/app-install/:provider/authorize", () => {
    it("redirects to authorization URL", async () => {
      const res = await app.request("/v1/app-install/test-slack/authorize");

      assertEquals(res.status, 302);
      const location = res.headers.get("Location");
      assertExists(location);
      assertMatch(location, /^https:\/\/slack\.com\/oauth\/v2\/authorize/);
      assertMatch(location, /state=[^&]+/);
      assertMatch(location, /redirect_uri=/);
    });

    it("includes redirect_uri in state when provided", async () => {
      const redirectUri = "https://myapp.example.com/settings";
      const res = await app.request(
        `/v1/app-install/test-slack/authorize?redirect_uri=${encodeURIComponent(redirectUri)}`,
      );

      assertEquals(res.status, 302);
      const location = res.headers.get("Location");
      assertExists(location);
    });

    it("returns 400 for invalid redirect_uri", async () => {
      const res = await app.request("/v1/app-install/test-slack/authorize?redirect_uri=not-a-url");

      assertEquals(res.status, 400);
      const json = ErrorResponseSchema.parse(await res.json());
      assertEquals(json.error, "invalid_redirect_uri");
    });

    it("returns 404 for unknown provider", async () => {
      const res = await app.request("/v1/app-install/unknown-provider/authorize");

      assertEquals(res.status, 404);
      const json = ErrorResponseSchema.parse(await res.json());
      assertEquals(json.error, "PROVIDER_NOT_FOUND");
    });

    it("returns 400 for non-app_install provider", async () => {
      // Register non-app_install provider
      registry.register({
        id: "oauth-provider",
        type: "oauth",
        displayName: "OAuth Provider",
        description: "Not app install",
        oauthConfig: { mode: "discovery", serverUrl: "https://example.com" },
        identify: () => Promise.resolve("user-123"),
      } as never);

      const res = await app.request("/v1/app-install/oauth-provider/authorize");

      assertEquals(res.status, 400);
      const json = ErrorResponseSchema.parse(await res.json());
      assertEquals(json.error, "INVALID_PROVIDER_TYPE");
    });
  });

  describe("GET /v1/app-install/callback", () => {
    it("completes flow and redirects with credential_id", async () => {
      // First get authorization URL to get valid state
      const startRes = await app.request(
        "/v1/app-install/test-slack/authorize?redirect_uri=https://myapp.example.com/settings",
      );
      const authUrl = startRes.headers.get("Location");
      assertExists(authUrl);
      const state = new URL(authUrl).searchParams.get("state");
      assertExists(state);

      // Complete callback
      const callbackRes = await app.request(
        `/v1/app-install/callback?state=${state}&code=test-code-123`,
      );

      assertEquals(callbackRes.status, 302);
      const location = callbackRes.headers.get("Location");
      assertExists(location);
      assertMatch(location, /^https:\/\/myapp\.example\.com\/settings/);
      const redirectUrl = new URL(location);
      assertExists(redirectUrl.searchParams.get("credential_id"));
      assertEquals(redirectUrl.searchParams.get("provider"), "test-slack");
    });

    it("renders success page when no redirect_uri", async () => {
      // Start without redirect_uri
      const startRes = await app.request("/v1/app-install/test-slack/authorize");
      const authUrl = startRes.headers.get("Location");
      assertExists(authUrl);
      const state = new URL(authUrl).searchParams.get("state");
      assertExists(state);

      // Complete callback
      const callbackRes = await app.request(
        `/v1/app-install/callback?state=${state}&code=test-code-123`,
      );

      assertEquals(callbackRes.status, 200);
      const json = SuccessResponseSchema.parse(await callbackRes.json());
      assertEquals(json.status, "success");
      assertEquals(json.provider, "test-slack");
    });

    it("handles OAuth denial with error param", async () => {
      // Start flow
      const startRes = await app.request(
        "/v1/app-install/test-slack/authorize?redirect_uri=https://myapp.example.com/settings",
      );
      const authUrl = startRes.headers.get("Location");
      assertExists(authUrl);
      const state = new URL(authUrl).searchParams.get("state");
      assertExists(state);

      // User denied access
      const callbackRes = await app.request(
        `/v1/app-install/callback?state=${state}&error=access_denied&error_description=User%20denied%20access`,
      );

      // App install routes return 400 with error (don't decode state for redirect)
      assertEquals(callbackRes.status, 400);
      const json = ErrorResponseSchema.parse(await callbackRes.json());
      assertEquals(json.status, "error");
      assertEquals(json.error, "access_denied");
      assertEquals(json.error_description, "User denied access");
    });

    it("returns 400 for missing query params", async () => {
      const res = await app.request("/v1/app-install/callback");

      assertEquals(res.status, 400);
      const json = ErrorResponseSchema.parse(await res.json());
      assertEquals(json.error, "invalid_query");
    });

    it("returns 400 for invalid state JWT", async () => {
      const res = await app.request(
        "/v1/app-install/callback?state=invalid-jwt-token&code=test-code",
      );

      assertEquals(res.status, 400);
      const json = ErrorResponseSchema.parse(await res.json());
      assertEquals(json.error, "STATE_INVALID");
    });

    it("returns 400 when code is missing and no error", async () => {
      // Start flow
      const startRes = await app.request("/v1/app-install/test-slack/authorize");
      const authUrl = startRes.headers.get("Location");
      assertExists(authUrl);
      const state = new URL(authUrl).searchParams.get("state");
      assertExists(state);

      // Callback without code or error
      const callbackRes = await app.request(`/v1/app-install/callback?state=${state}`);

      assertEquals(callbackRes.status, 400);
      const json = ErrorResponseSchema.parse(await callbackRes.json());
      assertEquals(json.error, "missing_code");
    });

    it("re-install updates existing credential", async () => {
      // First install
      const start1 = await app.request("/v1/app-install/test-slack/authorize");
      const location1 = start1.headers.get("Location");
      assertExists(location1);
      const state1 = new URL(location1).searchParams.get("state");
      assertExists(state1);
      const callback1 = await app.request(
        `/v1/app-install/callback?state=${state1}&code=same-team`,
      );
      assertEquals(callback1.status, 200);
      const result1 = SuccessResponseSchema.parse(await callback1.json());
      const credId1 = result1.credential_id;

      // Second install with same team
      const start2 = await app.request("/v1/app-install/test-slack/authorize");
      const location2 = start2.headers.get("Location");
      assertExists(location2);
      const state2 = new URL(location2).searchParams.get("state");
      assertExists(state2);
      const callback2 = await app.request(
        `/v1/app-install/callback?state=${state2}&code=same-team`,
      );
      assertEquals(callback2.status, 200);
      const result2 = SuccessResponseSchema.parse(await callback2.json());

      // Should reuse same credential ID
      assertEquals(result2.credential_id, credId1);

      // Should only have one credential
      const allCreds = await storage.list("oauth", "dev");
      assertEquals(allCreds.length, 1);
    });
  });

  describe("POST /v1/app-install/:provider/reconcile", () => {
    it("reconciles route for existing credential", async () => {
      // First create a credential via install flow
      const startRes = await app.request("/v1/app-install/test-slack/authorize");
      const location = startRes.headers.get("Location");
      assertExists(location);
      const state = new URL(location).searchParams.get("state");
      assertExists(state);
      const callback = await app.request(`/v1/app-install/callback?state=${state}&code=team-123`);
      const { credential_id } = SuccessResponseSchema.parse(await callback.json());

      // Reconcile route
      const res = await app.request("/v1/app-install/test-slack/reconcile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ credential_id }),
      });

      assertEquals(res.status, 200);
      const json = z.object({ status: z.string(), message: z.string() }).parse(await res.json());
      assertEquals(json.status, "ok");
    });

    it("returns 404 for unknown provider", async () => {
      const res = await app.request("/v1/app-install/unknown/reconcile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ credential_id: "cred-1" }),
      });

      assertEquals(res.status, 404);
      const json = ErrorResponseSchema.parse(await res.json());
      assertEquals(json.error, "PROVIDER_NOT_FOUND");
    });

    it("returns 500 for non-existent credential", async () => {
      const res = await app.request("/v1/app-install/test-slack/reconcile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ credential_id: "non-existent" }),
      });

      assertEquals(res.status, 500);
      const json = ErrorResponseSchema.parse(await res.json());
      assertEquals(json.error, "CREDENTIAL_NOT_FOUND");
    });

    it("returns 400 for missing body fields", async () => {
      const res = await app.request("/v1/app-install/test-slack/reconcile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      assertEquals(res.status, 400);
      const json = ErrorResponseSchema.parse(await res.json());
      assertEquals(json.error, "invalid_body");
    });
  });
});
