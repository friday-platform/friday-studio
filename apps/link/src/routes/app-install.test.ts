/**
 * App Install Routes Integration Tests
 * Tests HTTP endpoints with real routes and mocked services
 */

import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { PlatformRouteRepository } from "../adapters/platform-route-repository.ts";
import { AppInstallError } from "../app-install/errors.ts";
import { AppInstallService } from "../app-install/service.ts";
import { factory } from "../factory.ts";
import { OAuthService } from "../oauth/service.ts";
import { ProviderRegistry } from "../providers/registry.ts";
import { defineAppInstallProvider } from "../providers/types.ts";
import type {
  Credential,
  CredentialInput,
  Metadata,
  SaveResult,
  StorageAdapter,
} from "../types.ts";
import { createAppInstallRoutes } from "./app-install.ts";
import { createCallbackRoutes } from "./callback.ts";

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
 * Mock implementations for external boundaries (storage, routes)
 */

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

  // Not used by service - stub to satisfy interface
  upsert(): Promise<SaveResult> {
    throw new Error("MockStorageAdapter.upsert() should not be called");
  }
  updateMetadata(): Promise<Metadata> {
    throw new Error("MockStorageAdapter.updateMetadata() should not be called");
  }
}

class MockPlatformRouteRepository implements PlatformRouteRepository {
  private routes = new Map<string, string>();

  upsert(teamId: string, userId: string): Promise<void> {
    this.routes.set(teamId, userId);
    return Promise.resolve();
  }

  delete(teamId: string): Promise<void> {
    this.routes.delete(teamId);
    return Promise.resolve();
  }
}

describe("App Install Routes", () => {
  let registry: ProviderRegistry;
  let storage: MockStorageAdapter;
  let routeStorage: MockPlatformRouteRepository;
  let service: AppInstallService;
  let oauthService: OAuthService;
  let app: ReturnType<typeof factory.createApp>;

  /** Helper to build a GitHub credential result */
  function githubCredential(installationId: number, orgName: string) {
    return {
      externalId: String(installationId),
      externalName: orgName,
      credential: {
        type: "oauth" as const,
        provider: "github",
        label: orgName,
        secret: {
          platform: "github" as const,
          externalId: String(installationId),
          access_token: `ghs_${installationId}`,
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          github: { installationId, organizationName: orgName, organizationId: installationId },
        },
      },
    };
  }

  const mockGitHubProvider = defineAppInstallProvider({
    id: "github",
    platform: "github",
    displayName: "GitHub",
    description: "GitHub App",
    buildAuthorizationUrl(callbackUrl, state) {
      return `https://github.com/apps/test/installations/new?state=${state}&redirect_uri=${encodeURIComponent(callbackUrl)}`;
    },
    completeInstallation(code, _callbackUrl, callbackParams) {
      const setupAction = callbackParams?.get("setup_action");
      if (setupAction === "request") {
        throw new AppInstallError(
          "APPROVAL_PENDING",
          "GitHub App installation is pending admin approval",
        );
      }
      if (!code) {
        throw new AppInstallError("MISSING_CODE", "No authorization code provided");
      }
      return Promise.resolve(githubCredential(12345, "test-org"));
    },
    completeReinstallation(installationId) {
      return Promise.resolve(githubCredential(installationId, "reinstalled-org"));
    },
  });

  const mockProvider = defineAppInstallProvider({
    id: "test-slack",
    platform: "slack",
    displayName: "Test Slack",
    description: "Test provider",
    buildAuthorizationUrl(callbackUrl, state) {
      return `https://slack.com/oauth/v2/authorize?state=${state}&redirect_uri=${encodeURIComponent(callbackUrl)}`;
    },
    completeInstallation(code, _callbackUrl) {
      // Slack-like providers require authorization code
      if (!code) {
        throw new AppInstallError("MISSING_CODE", "No authorization code provided");
      }
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
          secret: {
            platform: "slack",
            externalId: `team-${code}`,
            access_token: `xoxb-${code}`,
            token_type: "bot",
          },
        },
      });
    },
  });

  beforeEach(() => {
    registry = new ProviderRegistry();
    storage = new MockStorageAdapter();
    routeStorage = new MockPlatformRouteRepository();
    service = new AppInstallService(registry, storage, routeStorage, "https://link.example.com");
    oauthService = new OAuthService(registry, storage);

    // Register mock provider
    registry.register(mockProvider);

    // Create app with routes (including unified callback)
    // Add middleware to set userId (simulates tenancy middleware from main app)
    app = factory
      .createApp()
      .use("*", async (c, next) => {
        c.set("userId", "test-user");
        await next();
      })
      .route("/v1/app-install", createAppInstallRoutes(service))
      .route("/v1/callback", createCallbackRoutes(oauthService, service));
  });

  describe("GET /v1/app-install/:provider/authorize", () => {
    it("redirects to authorization URL", async () => {
      const res = await app.request("/v1/app-install/test-slack/authorize");

      expect(res.status).toEqual(302);
      const location = res.headers.get("Location");
      expect(location).toBeDefined();
      expect(location).toMatch(/^https:\/\/slack\.com\/oauth\/v2\/authorize/);
      expect(location).toMatch(/state=[^&]+/);
      expect(location).toMatch(/redirect_uri=/);
    });

    it("includes redirect_uri in state when provided", async () => {
      const redirectUri = "https://myapp.example.com/settings";
      const res = await app.request(
        `/v1/app-install/test-slack/authorize?redirect_uri=${encodeURIComponent(redirectUri)}`,
      );

      expect(res.status).toEqual(302);
      const location = res.headers.get("Location");
      expect(location).toBeDefined();
    });

    it("returns 400 for invalid redirect_uri", async () => {
      const res = await app.request("/v1/app-install/test-slack/authorize?redirect_uri=not-a-url");

      expect(res.status).toEqual(400);
      const json = ErrorResponseSchema.parse(await res.json());
      expect(json.error).toEqual("invalid_redirect_uri");
    });

    it("returns 404 for unknown provider", async () => {
      const res = await app.request("/v1/app-install/unknown-provider/authorize");

      expect(res.status).toEqual(404);
      const json = ErrorResponseSchema.parse(await res.json());
      expect(json.error).toEqual("PROVIDER_NOT_FOUND");
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

      expect(res.status).toEqual(400);
      const json = ErrorResponseSchema.parse(await res.json());
      expect(json.error).toEqual("INVALID_PROVIDER_TYPE");
    });
  });

  describe("GET /v1/callback/:provider (app install)", () => {
    it("completes flow and redirects with credential_id", async () => {
      // First get authorization URL to get valid state
      const startRes = await app.request(
        "/v1/app-install/test-slack/authorize?redirect_uri=https://myapp.example.com/settings",
      );
      const authUrl = startRes.headers.get("Location");
      if (!authUrl) throw new Error("authUrl should be defined");
      const state = new URL(authUrl).searchParams.get("state");
      if (!state) throw new Error("state should be defined");

      // Complete callback via unified route
      const callbackRes = await app.request(
        `/v1/callback/test-slack?state=${state}&code=test-code-123`,
      );

      expect(callbackRes.status).toEqual(302);
      const location = callbackRes.headers.get("Location");
      if (!location) throw new Error("location should be defined");
      expect(location).toMatch(/^https:\/\/myapp\.example\.com\/settings/);
      const redirectUrl = new URL(location);
      expect(redirectUrl.searchParams.get("credential_id")).toBeDefined();
      expect(redirectUrl.searchParams.get("provider")).toEqual("test-slack");
    });

    it("renders success page when no redirect_uri", async () => {
      // Start without redirect_uri
      const startRes = await app.request("/v1/app-install/test-slack/authorize");
      const authUrl = startRes.headers.get("Location");
      if (!authUrl) throw new Error("authUrl should be defined");
      const state = new URL(authUrl).searchParams.get("state");
      if (!state) throw new Error("state should be defined");

      // Complete callback via unified route
      const callbackRes = await app.request(
        `/v1/callback/test-slack?state=${state}&code=test-code-123`,
      );

      expect(callbackRes.status).toEqual(200);
      const json = SuccessResponseSchema.parse(await callbackRes.json());
      expect(json.status).toEqual("success");
      expect(json.provider).toEqual("test-slack");
    });

    it("handles OAuth denial with error param and redirects", async () => {
      // Start flow
      const startRes = await app.request(
        "/v1/app-install/test-slack/authorize?redirect_uri=https://myapp.example.com/settings",
      );
      const authUrl = startRes.headers.get("Location");
      if (!authUrl) throw new Error("authUrl should be defined");
      const state = new URL(authUrl).searchParams.get("state");
      if (!state) throw new Error("state should be defined");

      // User denied access - unified callback redirects with error
      const callbackRes = await app.request(
        `/v1/callback/test-slack?state=${state}&error=access_denied&error_description=User%20denied%20access`,
      );

      // Unified callback redirects to redirect_uri with error params
      expect(callbackRes.status).toEqual(302);
      const location = callbackRes.headers.get("Location");
      if (!location) throw new Error("location should be defined");
      const redirectUrl = new URL(location);
      expect(redirectUrl.searchParams.get("error")).toEqual("access_denied");
      expect(redirectUrl.searchParams.get("error_description")).toEqual("User denied access");
    });

    it("returns 400 for invalid state JWT", async () => {
      const res = await app.request(
        "/v1/callback/test-slack?state=invalid-jwt-token&code=test-code",
      );

      expect(res.status).toEqual(400);
      const json = ErrorResponseSchema.parse(await res.json());
      expect(json.error).toEqual("invalid_state");
    });

    it("returns 400 when code is missing and no error", async () => {
      // Start flow
      const startRes = await app.request("/v1/app-install/test-slack/authorize");
      const authUrl = startRes.headers.get("Location");
      if (!authUrl) throw new Error("authUrl should be defined");
      const state = new URL(authUrl).searchParams.get("state");
      if (!state) throw new Error("state should be defined");

      // Callback without code or error
      const callbackRes = await app.request(`/v1/callback/test-slack?state=${state}`);

      expect(callbackRes.status).toEqual(400);
      const json = ErrorResponseSchema.parse(await callbackRes.json());
      expect(json.error).toEqual("missing_code");
    });

    it("returns 400 for provider mismatch between URL and state", async () => {
      // Start flow for test-slack
      const startRes = await app.request("/v1/app-install/test-slack/authorize");
      const authUrl = startRes.headers.get("Location");
      if (!authUrl) throw new Error("authUrl should be defined");
      const state = new URL(authUrl).searchParams.get("state");
      if (!state) throw new Error("state should be defined");

      // Callback with wrong provider in URL
      const callbackRes = await app.request(
        `/v1/callback/wrong-provider?state=${state}&code=test-code`,
      );

      expect(callbackRes.status).toEqual(400);
      const json = ErrorResponseSchema.parse(await callbackRes.json());
      expect(json.error).toEqual("provider_mismatch");
    });

    it("returns approval_pending error for GitHub setup_action=request", async () => {
      registry.register(mockGitHubProvider);

      const startRes = await app.request("/v1/app-install/github/authorize");
      const authUrl = startRes.headers.get("Location");
      if (!authUrl) throw new Error("authUrl should be defined");
      const state = new URL(authUrl).searchParams.get("state");
      if (!state) throw new Error("state should be defined");

      // GitHub sends setup_action=request when admin approval is required (no code, no error)
      const callbackRes = await app.request(
        `/v1/callback/github?state=${state}&setup_action=request`,
      );

      expect(callbackRes.status).toEqual(400);
      const json = ErrorResponseSchema.parse(await callbackRes.json());
      expect(json.error).toEqual("approval_pending");
      expect(json.error_description).toContain("pending admin approval");
    });

    it("completes reinstall flow for GitHub setup_action=update with installation_id and no code", async () => {
      registry.register(mockGitHubProvider);

      const startRes = await app.request("/v1/app-install/github/authorize");
      const authUrl = startRes.headers.get("Location");
      if (!authUrl) throw new Error("authUrl should be defined");
      const state = new URL(authUrl).searchParams.get("state");
      if (!state) throw new Error("state should be defined");

      // GitHub sends setup_action=update with installation_id but NO code when
      // app is already installed on the org but credential was deleted from Link
      const callbackRes = await app.request(
        `/v1/callback/github?state=${state}&setup_action=update&installation_id=54321`,
      );

      expect(callbackRes.status).toEqual(200);
      const json = SuccessResponseSchema.parse(await callbackRes.json());
      expect(json.status).toEqual("success");
      expect(json.provider).toEqual("github");
      expect(json.credential_id).toBeDefined();
    });

    it("re-install updates existing credential", async () => {
      // First install
      const start1 = await app.request("/v1/app-install/test-slack/authorize");
      const location1 = start1.headers.get("Location");
      if (!location1) throw new Error("location1 should be defined");
      const state1 = new URL(location1).searchParams.get("state");
      if (!state1) throw new Error("state1 should be defined");
      const callback1 = await app.request(`/v1/callback/test-slack?state=${state1}&code=same-team`);
      expect(callback1.status).toEqual(200);
      const result1 = SuccessResponseSchema.parse(await callback1.json());
      const credId1 = result1.credential_id;

      // Second install with same team
      const start2 = await app.request("/v1/app-install/test-slack/authorize");
      const location2 = start2.headers.get("Location");
      if (!location2) throw new Error("location2 should be defined");
      const state2 = new URL(location2).searchParams.get("state");
      if (!state2) throw new Error("state2 should be defined");
      const callback2 = await app.request(`/v1/callback/test-slack?state=${state2}&code=same-team`);
      expect(callback2.status).toEqual(200);
      const result2 = SuccessResponseSchema.parse(await callback2.json());

      // Should reuse same credential ID (proves idempotent update)
      expect(result2.credential_id).toEqual(credId1);
    });
  });

  describe("POST /v1/app-install/:provider/reconcile", () => {
    it("reconciles route for existing credential", async () => {
      // First create a credential via install flow
      const startRes = await app.request("/v1/app-install/test-slack/authorize");
      const location = startRes.headers.get("Location");
      if (!location) throw new Error("location should be defined");
      const state = new URL(location).searchParams.get("state");
      if (!state) throw new Error("state should be defined");
      const callback = await app.request(`/v1/callback/test-slack?state=${state}&code=team-123`);
      const { credential_id } = SuccessResponseSchema.parse(await callback.json());

      // Reconcile route
      const res = await app.request("/v1/app-install/test-slack/reconcile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ credential_id }),
      });

      expect(res.status).toEqual(200);
      const json = z.object({ status: z.string(), message: z.string() }).parse(await res.json());
      expect(json.status).toEqual("ok");
    });

    it("returns 404 for unknown provider", async () => {
      const res = await app.request("/v1/app-install/unknown/reconcile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ credential_id: "cred-1" }),
      });

      expect(res.status).toEqual(404);
      const json = ErrorResponseSchema.parse(await res.json());
      expect(json.error).toEqual("PROVIDER_NOT_FOUND");
    });

    it("returns 500 for non-existent credential", async () => {
      const res = await app.request("/v1/app-install/test-slack/reconcile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ credential_id: "non-existent" }),
      });

      expect(res.status).toEqual(500);
      const json = ErrorResponseSchema.parse(await res.json());
      expect(json.error).toEqual("CREDENTIAL_NOT_FOUND");
    });

    it("returns 400 for missing body fields", async () => {
      const res = await app.request("/v1/app-install/test-slack/reconcile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      expect(res.status).toEqual(400);
      const json = ErrorResponseSchema.parse(await res.json());
      expect(json.error).toEqual("invalid_body");
    });
  });
});
