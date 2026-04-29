import { beforeEach, describe, expect, it } from "vitest";
import { TestPlatformRouteRepository, TestStorageAdapter } from "../adapters/test-storage.ts";
import { ProviderRegistry } from "../providers/registry.ts";
import { defineAppInstallProvider } from "../providers/types.ts";
import { AppInstallError } from "./errors.ts";
import { AppInstallService } from "./service.ts";

describe("AppInstallService", () => {
  let registry: ProviderRegistry;
  let storage: TestStorageAdapter;
  let routeStorage: TestPlatformRouteRepository;
  let service: AppInstallService;

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

    // Register mock provider
    registry.register(mockProvider);
  });

  describe("initiateInstall", () => {
    it("returns authorization URL with state JWT", async () => {
      const result = await service.initiateInstall(
        "test-slack",
        "https://app.example.com/settings",
      );

      expect(result.authorizationUrl.startsWith("https://slack.com/oauth/v2/authorize")).toEqual(
        true,
      );
      expect(result.authorizationUrl).toContain("state=");
      // Callback URL should include provider name for readability (e.g., /v1/callback/test-slack)
      expect(result.authorizationUrl).toContain(
        "redirect_uri=https%3A%2F%2Flink.example.com%2Fv1%2Fcallback%2Ftest-slack",
      );
    });

    it("throws PROVIDER_NOT_FOUND for unknown provider", async () => {
      const error = await service.initiateInstall("unknown-provider").catch((e: unknown) => e);
      expect(error).toBeInstanceOf(AppInstallError);
      expect((error as AppInstallError).code).toEqual("PROVIDER_NOT_FOUND");
    });

    it("throws INVALID_PROVIDER_TYPE for non-app_install provider", async () => {
      // Register non-app_install provider
      registry.register({
        id: "oauth-provider",
        type: "oauth",
        displayName: "OAuth Provider",
        description: "Not app install",
        oauthConfig: { mode: "discovery", serverUrl: "https://example.com" },
        identify: () => Promise.resolve("user-123"),
      } as never);

      const error = await service.initiateInstall("oauth-provider").catch((e: unknown) => e);
      expect(error).toBeInstanceOf(AppInstallError);
      expect((error as AppInstallError).code).toEqual("INVALID_PROVIDER_TYPE");
    });
  });

  describe("completeInstall", () => {
    it("creates new credential on first install", async () => {
      // First initiate to get valid state
      const { authorizationUrl } = await service.initiateInstall("test-slack");
      const state = new URL(authorizationUrl).searchParams.get("state");
      if (!state) throw new Error("state should be defined");

      // Complete install
      const result = await service.completeInstall(state, "test-code-123");

      expect(result.credential.provider).toEqual("test-slack");
      expect(result.credential.label).toEqual("Test Workspace");
      expect(result.updated).toEqual(false);
      expect(result.redirectUri).toEqual(undefined);

      // Verify credential stored
      const stored = await storage.get(result.credential.id, "dev");
      expect(stored?.provider).toEqual("test-slack");

      // Slack skips platform_route (uses per-app webhook routing)
    });

    it("updates existing credential on re-install", async () => {
      // First install
      const { authorizationUrl: url1 } = await service.initiateInstall("test-slack");
      const state1 = new URL(url1).searchParams.get("state");
      if (!state1) throw new Error("state1 should be defined");
      const result1 = await service.completeInstall(state1, "same-team");

      const firstId = result1.credential.id;

      // Second install with same team ID
      const { authorizationUrl: url2 } = await service.initiateInstall("test-slack");
      const state2 = new URL(url2).searchParams.get("state");
      if (!state2) throw new Error("state2 should be defined");
      const result2 = await service.completeInstall(state2, "same-team");

      // Should reuse same credential ID
      expect(result2.credential.id).toEqual(firstId);
      expect(result2.updated).toEqual(true);

      // Should only have one credential
      const allCreds = await storage.list("oauth", "dev");
      expect(allCreds.length).toEqual(1);
    });

    it("includes redirectUri from state when provided", async () => {
      const { authorizationUrl } = await service.initiateInstall(
        "test-slack",
        "https://app.example.com/settings",
      );
      const state = new URL(authorizationUrl).searchParams.get("state");
      if (!state) throw new Error("state should be defined");

      const result = await service.completeInstall(state, "test-code");

      expect(result.redirectUri).toEqual("https://app.example.com/settings");
    });

    it("throws STATE_INVALID for invalid JWT", async () => {
      const error = await service
        .completeInstall("invalid-jwt-token", "code")
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(AppInstallError);
      expect((error as AppInstallError).code).toEqual("STATE_INVALID");
    });
  });

  describe("reconcileRoute", () => {
    it("updates platform routing from credential", async () => {
      // Create credential manually
      const { id } = await storage.save(
        {
          type: "oauth",
          provider: "test-slack",
          label: "Test Workspace",
          secret: mockSecret("team-reconcile-123"),
        },
        "user-123",
      );

      // Reconcile route — no-op when usesRouteTable is false
      await service.reconcileRoute("test-slack", id, "user-123");

      // Slack skips platform_route, so no route should exist
      expect(routeStorage.getRoute("team-reconcile-123")).toBeUndefined();
    });

    it("throws CREDENTIAL_NOT_FOUND for missing credential", async () => {
      const error = await service
        .reconcileRoute("test-slack", "nonexistent-id", "user-123")
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(AppInstallError);
      expect((error as AppInstallError).code).toEqual("CREDENTIAL_NOT_FOUND");
    });

    it("throws CREDENTIAL_NOT_FOUND for mismatched provider", async () => {
      const { id } = await storage.save(
        {
          type: "oauth",
          provider: "different-provider",
          label: "Test",
          secret: { externalId: "team-123", access_token: "token", token_type: "bot" },
        },
        "user-123",
      );

      const error = await service
        .reconcileRoute("test-slack", id, "user-123")
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(AppInstallError);
      expect((error as AppInstallError).code).toEqual("CREDENTIAL_NOT_FOUND");
    });

    it("throws INVALID_CREDENTIAL for credential missing externalId", async () => {
      const { id } = await storage.save(
        {
          type: "oauth",
          provider: "test-slack",
          label: "Test",
          secret: { access_token: "token", token_type: "bot" }, // Missing externalId
        },
        "user-123",
      );

      const error = await service
        .reconcileRoute("test-slack", id, "user-123")
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(AppInstallError);
      expect((error as AppInstallError).code).toEqual("INVALID_CREDENTIAL");
    });
  });

  describe("reconnect", () => {
    function githubResult(installationId: string, orgName: string) {
      return {
        externalId: installationId,
        externalName: orgName,
        credential: {
          type: "oauth" as const,
          provider: "test-github-reconnect",
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

    const mockGitHubReconnectProvider = defineAppInstallProvider({
      id: "test-github-reconnect",
      platform: "github",
      displayName: "Test GitHub Reconnect",
      description: "Test GitHub provider with completeReinstallation",
      buildAuthorizationUrl(_callbackUrl, state) {
        return Promise.resolve(`https://github.com/apps/test/installations/new?state=${state}`);
      },
      completeInstallation() {
        return Promise.reject(new Error("Should not be called"));
      },
      completeReinstallation(installationId) {
        const names: Record<string, string> = { "111": "org-one", "222": "org-two" };
        return Promise.resolve(githubResult(installationId, names[installationId] ?? "unknown"));
      },
    });

    beforeEach(() => {
      registry.register(mockGitHubReconnectProvider);
    });

    it("refreshes credentials for user-owned installations only", async () => {
      // Seed routes owned by user-1
      routeStorage.seedRoute("111", "user-1", "github");
      routeStorage.seedRoute("222", "user-1", "github");

      const result = await service.reconnect("test-github-reconnect", "user-1");

      expect(result).toHaveLength(2);
      expect(result).toMatchObject([{ label: "org-one" }, { label: "org-two" }]);

      // Verify routes still belong to user-1
      expect(routeStorage.getRoute("111")).toEqual("user-1");
      expect(routeStorage.getRoute("222")).toEqual("user-1");
    });

    it("returns null when user has no owned routes", async () => {
      const result = await service.reconnect("test-github-reconnect", "user-with-nothing");
      expect(result).toBeNull();
    });

    it("does not reconnect installations owned by other users", async () => {
      // Route owned by someone else
      routeStorage.seedRoute("111", "other-user", "github");

      const result = await service.reconnect("test-github-reconnect", "user-1");
      expect(result).toBeNull();
    });

    it("only returns routes matching the provider platform", async () => {
      // User owns both Slack and GitHub routes
      routeStorage.seedRoute("T01234ABC", "user-1", "slack");
      routeStorage.seedRoute("111", "user-1", "github");

      const result = await service.reconnect("test-github-reconnect", "user-1");

      // Only the GitHub route should be reconnected
      expect(result).toHaveLength(1);
      expect(result).toMatchObject([{ label: "org-one" }]);
    });

    it("returns null when provider has no completeReinstallation", async () => {
      const result = await service.reconnect("test-slack");
      expect(result).toBeNull();
    });

    it("throws PROVIDER_NOT_FOUND for unknown provider", async () => {
      const error = await service.reconnect("unknown").catch((e: unknown) => e);
      expect(error).toBeInstanceOf(AppInstallError);
      expect((error as AppInstallError).code).toEqual("PROVIDER_NOT_FOUND");
    });

    it("skips failing installations and returns successful ones", async () => {
      routeStorage.seedRoute("111", "user-1", "github");
      routeStorage.seedRoute("999", "user-1", "github"); // Will fail — unknown id

      const failingProvider = defineAppInstallProvider({
        id: "test-github-partial",
        platform: "github",
        displayName: "Test GitHub Partial",
        description: "Fails on unknown installations",
        buildAuthorizationUrl(_callbackUrl, state) {
          return Promise.resolve(`https://github.com/apps/test/installations/new?state=${state}`);
        },
        completeInstallation() {
          return Promise.reject(new Error("Should not be called"));
        },
        completeReinstallation(installationId) {
          if (installationId === "999") {
            return Promise.reject(new Error("Installation not found"));
          }
          return Promise.resolve(githubResult(installationId, "org-one"));
        },
      });
      registry.register(failingProvider);

      const result = await service.reconnect("test-github-partial", "user-1");
      expect(result).toHaveLength(1);
      expect(result).toMatchObject([{ label: "org-one" }]);
    });
  });

  describe("completeInstall reinstall path", () => {
    const mockGitHubProvider = defineAppInstallProvider({
      id: "test-github",
      platform: "github",
      displayName: "Test GitHub",
      description: "Test GitHub provider",
      buildAuthorizationUrl(_callbackUrl, state) {
        return Promise.resolve(`https://github.com/apps/test/installations/new?state=${state}`);
      },
      completeInstallation() {
        return Promise.reject(new Error("Should not be called in reinstall flow"));
      },
      completeReinstallation(installationId) {
        return Promise.resolve({
          externalId: installationId,
          externalName: "test-org",
          credential: {
            type: "oauth",
            provider: "test-github",
            label: "test-org",
            secret: {
              platform: "github",
              externalId: installationId,
              access_token: "ghs_test_token",
              expires_at: Math.floor(Date.now() / 1000) + 3600,
              github: {
                installationId: Number(installationId),
                organizationName: "test-org",
                organizationId: 12345,
              },
            },
          },
        });
      },
    });

    beforeEach(() => {
      registry.register(mockGitHubProvider);
    });

    it("creates new credential on reinstall via completeInstall", async () => {
      const { authorizationUrl } = await service.initiateInstall("test-github");
      const state = new URL(authorizationUrl).searchParams.get("state");
      if (!state) throw new Error("state should be defined");

      // No code, but installation_id present — triggers reinstall path
      const params = new URLSearchParams({ installation_id: "98765" });
      const result = await service.completeInstall(state, undefined, params);

      expect(result.credential.provider).toEqual("test-github");
      expect(result.credential.label).toEqual("test-org");
      expect(result.updated).toEqual(false);

      // Verify credential stored
      const stored = await storage.get(result.credential.id, "dev");
      expect(stored?.provider).toEqual("test-github");

      // Verify route created
      expect(routeStorage.getRoute("98765")).toEqual("dev");
    });

    it("updates existing credential on reinstall via completeInstall", async () => {
      await storage.save(
        {
          type: "oauth",
          provider: "test-github",
          label: "test-org",
          secret: {
            platform: "github",
            externalId: "98765",
            access_token: "old_token",
            expires_at: 0,
            github: { installationId: 98765, organizationName: "test-org", organizationId: 12345 },
          },
        },
        "dev",
      );

      const { authorizationUrl } = await service.initiateInstall("test-github");
      const state = new URL(authorizationUrl).searchParams.get("state");
      if (!state) throw new Error("state should be defined");

      const params = new URLSearchParams({ installation_id: "98765" });
      const result = await service.completeInstall(state, undefined, params);

      expect(result.updated).toEqual(true);

      const allCreds = await storage.list("oauth", "dev");
      expect(allCreds.length).toEqual(1);
    });

    it("rejects no-code reinstall when installation belongs to another user", async () => {
      // Route owned by a different user
      routeStorage.seedRoute("98765", "other-user", "github");

      const { authorizationUrl } = await service.initiateInstall("test-github");
      const state = new URL(authorizationUrl).searchParams.get("state");
      if (!state) throw new Error("state should be defined");

      const params = new URLSearchParams({ installation_id: "98765" });
      await expect(service.completeInstall(state, undefined, params)).rejects.toMatchObject({
        code: "INSTALLATION_OWNED",
      });
    });

    it("allows no-code reinstall when installation is unowned", async () => {
      // No route exists — installation is unclaimed
      const { authorizationUrl } = await service.initiateInstall("test-github");
      const state = new URL(authorizationUrl).searchParams.get("state");
      if (!state) throw new Error("state should be defined");

      const params = new URLSearchParams({ installation_id: "98765" });
      const result = await service.completeInstall(state, undefined, params);
      expect(result.credential.provider).toEqual("test-github");
    });

    it("falls through to provider when no code and no completeReinstallation", async () => {
      // test-slack provider doesn't have completeReinstallation — provider throws MISSING_CODE
      const { authorizationUrl } = await service.initiateInstall("test-slack");
      const state = new URL(authorizationUrl).searchParams.get("state");
      if (!state) throw new Error("state should be defined");

      const error = await service
        .completeInstall(state, undefined, new URLSearchParams({ installation_id: "12345" }))
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(AppInstallError);
      expect((error as AppInstallError).code).toEqual("MISSING_CODE");
    });
  });

  describe("uninstall", () => {
    it("deletes route and credential", async () => {
      const { authorizationUrl } = await service.initiateInstall("test-slack");
      const state = new URL(authorizationUrl).searchParams.get("state");
      if (!state) throw new Error("state should be defined");
      const result = await service.completeInstall(state, "uninstall-team");

      await service.uninstall("test-slack", result.credential.id, "dev");

      // Credential deleted
      const stored = await storage.get(result.credential.id, "dev");
      expect(stored).toBeNull();
    });

    it("is idempotent when credential already deleted", async () => {
      await expect(service.uninstall("test-slack", "non-existent", "dev")).resolves.toBeUndefined();
    });

    it("throws INVALID_PROVIDER_TYPE for provider mismatch", async () => {
      // Register a second provider
      registry.register(
        defineAppInstallProvider({
          id: "other-provider",
          platform: "slack",
          usesRouteTable: false,
          displayName: "Other",
          description: "Other",
          buildAuthorizationUrl(_cb, state) {
            return Promise.resolve(`https://example.com?state=${state}`);
          },
          completeInstallation() {
            return Promise.reject(new Error("unused"));
          },
        }),
      );

      // Create credential under test-slack
      const { authorizationUrl } = await service.initiateInstall("test-slack");
      const state = new URL(authorizationUrl).searchParams.get("state");
      if (!state) throw new Error("state should be defined");
      const result = await service.completeInstall(state, "mismatch-team");

      // Try to uninstall with wrong provider — credential.provider is test-slack
      await expect(
        service.uninstall("other-provider", result.credential.id, "dev"),
      ).rejects.toMatchObject({ code: "INVALID_PROVIDER_TYPE" });
    });

    it("throws PROVIDER_NOT_FOUND for unknown provider", async () => {
      await expect(service.uninstall("unknown-provider", "cred-1", "dev")).rejects.toMatchObject({
        code: "PROVIDER_NOT_FOUND",
      });
    });
  });
});
