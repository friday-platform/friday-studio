import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { TestPlatformRouteRepository, TestStorageAdapter } from "../adapters/test-storage.ts";
import { AppInstallError } from "../app-install/errors.ts";
import { AppInstallService } from "../app-install/service.ts";
import { factory } from "../factory.ts";
import { OAuthService } from "../oauth/service.ts";
import { ProviderRegistry } from "../providers/registry.ts";
import { defineAppInstallProvider } from "../providers/types.ts";
import { createAppInstallRoutes } from "./app-install.ts";
import { createCallbackRoutes } from "./callback.ts";

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

describe("App Install Routes", () => {
  let registry: ProviderRegistry;
  let storage: TestStorageAdapter;
  let routeStorage: TestPlatformRouteRepository;
  let service: AppInstallService;
  let oauthService: OAuthService;
  let app: ReturnType<typeof factory.createApp>;

  /** Helper to build a GitHub credential result */
  function githubCredential(installationId: string, orgName: string, providerId = "github") {
    return {
      externalId: installationId,
      externalName: orgName,
      credential: {
        type: "oauth" as const,
        provider: providerId,
        label: orgName,
        secret: {
          platform: "github" as const,
          externalId: installationId,
          access_token: `ghs_${installationId}`,
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          github: {
            installationId: Number(installationId),
            organizationName: orgName,
            organizationId: Number(installationId),
          },
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
      return Promise.resolve(
        `https://github.com/apps/test/installations/new?state=${state}&redirect_uri=${encodeURIComponent(callbackUrl)}`,
      );
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
      return Promise.resolve(githubCredential("12345", "test-org"));
    },
    completeReinstallation(installationId) {
      return Promise.resolve(githubCredential(installationId, "reinstalled-org"));
    },
  });

  /** Mock secret shaped to satisfy AppInstallCredentialSecretSchema (github-only). */
  function mockSecret(externalId: string) {
    return {
      platform: "github" as const,
      externalId,
      access_token: `tok-${externalId}`,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      github: { installationId: 0, organizationName: "Test", organizationId: 0 },
    };
  }

  const mockProvider = defineAppInstallProvider({
    id: "test-slack",
    platform: "slack",
    usesRouteTable: false,
    displayName: "Test Slack",
    description: "Test provider",
    buildAuthorizationUrl(callbackUrl, state) {
      return Promise.resolve(
        `https://slack.com/oauth/v2/authorize?state=${state}&redirect_uri=${encodeURIComponent(callbackUrl)}`,
      );
    },
    completeInstallation(code, _callbackUrl) {
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
          secret: mockSecret(`team-${code}`),
        },
      });
    },
  });

  beforeEach(() => {
    registry = new ProviderRegistry();
    storage = new TestStorageAdapter();
    routeStorage = new TestPlatformRouteRepository();
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

  describe("GET /v1/app-install/:provider/authorize — reconnect short-circuit", () => {
    const reconnectProvider = defineAppInstallProvider({
      id: "github-reconnect",
      platform: "github",
      displayName: "GitHub Reconnect",
      description: "GitHub with completeReinstallation",
      buildAuthorizationUrl(_callbackUrl, state) {
        return Promise.resolve(`https://github.com/apps/test/installations/new?state=${state}`);
      },
      completeInstallation() {
        return Promise.reject(new Error("Should not be called"));
      },
      completeReinstallation(installationId) {
        return Promise.resolve(githubCredential(installationId, "my-org", "github-reconnect"));
      },
    });

    beforeEach(() => {
      registry.register(reconnectProvider);
    });

    it("redirects to redirect_uri with credential_id when reconnect succeeds", async () => {
      // Seed a route owned by test-user (set by middleware)
      routeStorage.seedRoute("999", "test-user", "github");

      const res = await app.request(
        `/v1/app-install/github-reconnect/authorize?redirect_uri=${encodeURIComponent("https://myapp.example.com/settings")}`,
      );

      expect(res.status).toEqual(302);
      const location = res.headers.get("Location");
      expect(location).toBeDefined();
      if (!location) throw new Error("location should be defined");
      const url = new URL(location);
      expect(url.origin + url.pathname).toEqual("https://myapp.example.com/settings");
      expect(url.searchParams.get("credential_id")).toBeDefined();
      expect(url.searchParams.get("provider")).toEqual("github-reconnect");
    });

    it("returns JSON when reconnect succeeds without redirect_uri", async () => {
      routeStorage.seedRoute("999", "test-user", "github");

      const res = await app.request("/v1/app-install/github-reconnect/authorize");

      expect(res.status).toEqual(200);
      const ReconnectResponseSchema = z.object({
        status: z.string(),
        provider: z.string(),
        credential_id: z.string(),
        credentials: z.array(z.object({ id: z.string(), provider: z.string(), label: z.string() })),
      });
      const json = ReconnectResponseSchema.parse(await res.json());
      expect(json.status).toEqual("success");
      expect(json.provider).toEqual("github-reconnect");
      expect(json.credential_id).toBeDefined();
      expect(json.credentials).toHaveLength(1);
      expect(json.credentials[0]?.label).toEqual("my-org");
    });

    it("falls through to OAuth redirect when user has no owned routes", async () => {
      // No routes owned by test-user — reconnect returns null
      const res = await app.request("/v1/app-install/github-reconnect/authorize");

      expect(res.status).toEqual(302);
      const location = res.headers.get("Location");
      expect(location).toMatch(/^https:\/\/github\.com\/apps\/test\/installations\/new/);
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
      expect(json.error).toEqual("MISSING_CODE");
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
      expect(json.error).toEqual("APPROVAL_PENDING");
      expect(json.message).toContain("pending admin approval");
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

    it("returns 403 when installation is owned by another user", async () => {
      registry.register(mockGitHubProvider);

      // Seed route owned by a different user
      routeStorage.seedRoute("54321", "other-user", "github");

      const startRes = await app.request("/v1/app-install/github/authorize");
      const authUrl = startRes.headers.get("Location");
      if (!authUrl) throw new Error("authUrl should be defined");
      const state = new URL(authUrl).searchParams.get("state");
      if (!state) throw new Error("state should be defined");

      // No-code callback with installation_id owned by other-user
      const callbackRes = await app.request(
        `/v1/callback/github?state=${state}&installation_id=54321`,
      );

      expect(callbackRes.status).toEqual(403);
      const json = ErrorResponseSchema.parse(await callbackRes.json());
      expect(json.error).toEqual("INSTALLATION_OWNED");
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

  describe("DELETE /v1/app-install/:provider/:credentialId", () => {
    it("returns 204 on successful uninstall", async () => {
      // Install first
      const startRes = await app.request("/v1/app-install/test-slack/authorize");
      const location = startRes.headers.get("Location");
      if (!location) throw new Error("location should be defined");
      const state = new URL(location).searchParams.get("state");
      if (!state) throw new Error("state should be defined");
      const callback = await app.request(`/v1/callback/test-slack?state=${state}&code=del-team`);
      const { credential_id } = SuccessResponseSchema.parse(await callback.json());

      const res = await app.request(`/v1/app-install/test-slack/${credential_id}`, {
        method: "DELETE",
      });
      expect(res.status).toEqual(204);
    });

    it("returns 204 on idempotent delete (credential already gone)", async () => {
      const res = await app.request("/v1/app-install/test-slack/nonexistent-cred", {
        method: "DELETE",
      });
      expect(res.status).toEqual(204);
    });

    it("returns 404 for unknown provider", async () => {
      const res = await app.request("/v1/app-install/unknown-provider/cred-1", {
        method: "DELETE",
      });
      expect(res.status).toEqual(404);
      const json = ErrorResponseSchema.parse(await res.json());
      expect(json.error).toEqual("PROVIDER_NOT_FOUND");
    });

    it("returns 400 for provider mismatch", async () => {
      // Install with test-slack
      const startRes = await app.request("/v1/app-install/test-slack/authorize");
      const location = startRes.headers.get("Location");
      if (!location) throw new Error("location should be defined");
      const state = new URL(location).searchParams.get("state");
      if (!state) throw new Error("state should be defined");
      const callback = await app.request(`/v1/callback/test-slack?state=${state}&code=mismatch`);
      const { credential_id } = SuccessResponseSchema.parse(await callback.json());

      // Delete with wrong provider
      registry.register(mockGitHubProvider);
      const res = await app.request(`/v1/app-install/github/${credential_id}`, {
        method: "DELETE",
      });
      expect(res.status).toEqual(400);
      const json = ErrorResponseSchema.parse(await res.json());
      expect(json.error).toEqual("INVALID_PROVIDER_TYPE");
    });
  });
});
