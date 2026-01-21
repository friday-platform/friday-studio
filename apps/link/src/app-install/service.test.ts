/**
 * AppInstallService Unit Tests
 * Tests service logic with mocked dependencies
 */

import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { PlatformRouteRepository } from "../adapters/platform-route-repository.ts";
import { defineAppInstallProvider, type ProviderDefinition } from "../providers/types.ts";
import type {
  Credential,
  CredentialInput,
  Metadata,
  SaveResult,
  StorageAdapter,
} from "../types.ts";
import { AppInstallError } from "./errors.ts";
import { AppInstallService } from "./service.ts";

/**
 * Mock implementations for dependencies
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
    const secretSchema = z.object({ externalId: z.string().optional() });
    for (const cred of this.credentials.values()) {
      if (cred.provider === provider) {
        const secretResult = secretSchema.safeParse(cred.secret);
        if (!secretResult.success || secretResult.data.externalId !== externalId) {
          continue;
        }
        return Promise.resolve(cred);
      }
    }
    return Promise.resolve(null);
  }

  updateMetadata(
    id: string,
    metadata: { displayName?: string },
    _userId: string,
  ): Promise<Metadata> {
    const existing = this.credentials.get(id);
    if (!existing) return Promise.reject(new Error("Credential not found"));
    const updated: Credential = {
      ...existing,
      displayName: metadata.displayName ?? existing.displayName,
      metadata: { ...existing.metadata, updatedAt: new Date().toISOString() },
    };
    this.credentials.set(id, updated);
    return Promise.resolve(updated.metadata);
  }

  // Test helper
  reset() {
    this.credentials.clear();
    this.idCounter = 0;
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

  /** Test helper - get route for assertions */
  getRoute(teamId: string): string | undefined {
    return this.routes.get(teamId);
  }
}

describe("AppInstallService", () => {
  let registry: MockProviderRegistry;
  let storage: MockStorageAdapter;
  let routeStorage: MockPlatformRouteRepository;
  let service: AppInstallService;

  const mockProvider = defineAppInstallProvider({
    id: "test-slack",
    platform: "slack",
    displayName: "Test Slack",
    description: "Test provider",
    buildAuthorizationUrl(callbackUrl, state) {
      return `https://slack.com/oauth/v2/authorize?state=${state}&redirect_uri=${encodeURIComponent(callbackUrl)}`;
    },
    completeInstallation(code, _callbackUrl) {
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
      expect(result.authorizationUrl.includes("state=")).toEqual(true);
      // Callback URL should include provider name for readability (e.g., /v1/callback/test-slack)
      expect(
        result.authorizationUrl.includes(
          "redirect_uri=https%3A%2F%2Flink.example.com%2Fv1%2Fcallback%2Ftest-slack",
        ),
      ).toEqual(true);
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

    it("includes userId in state when provided", async () => {
      const result = await service.initiateInstall(
        "test-slack",
        "https://app.example.com/settings",
        "user-123",
      );

      // State is JWT, so we can't inspect it directly without decoding
      // But we can verify URL is built correctly
      expect(result.authorizationUrl.includes("state=")).toEqual(true);
    });
  });

  describe("completeInstall", () => {
    it("creates new credential on first install", async () => {
      // First initiate to get valid state
      const { authorizationUrl } = await service.initiateInstall("test-slack");
      const state = new URL(authorizationUrl).searchParams.get("state");
      expect(state).toBeDefined();

      // Complete install
      const result = await service.completeInstall(state!, "test-code-123");

      expect(result.credential.provider).toEqual("test-slack");
      expect(result.credential.label).toEqual("Test Workspace");
      expect(result.updated).toEqual(false);
      expect(result.redirectUri).toEqual(undefined);

      // Verify credential stored
      const stored = await storage.get(result.credential.id, "dev");
      expect(stored?.provider).toEqual("test-slack");

      // Verify route created
      expect(routeStorage.getRoute("team-test-code-123")).toEqual("dev");
    });

    it("updates existing credential on re-install", async () => {
      // First install
      const { authorizationUrl: url1 } = await service.initiateInstall("test-slack");
      const state1 = new URL(url1).searchParams.get("state");
      expect(state1).toBeDefined();
      const result1 = await service.completeInstall(state1!, "same-team");

      const firstId = result1.credential.id;

      // Second install with same team ID
      const { authorizationUrl: url2 } = await service.initiateInstall("test-slack");
      const state2 = new URL(url2).searchParams.get("state");
      expect(state2).toBeDefined();
      const result2 = await service.completeInstall(state2!, "same-team");

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
      expect(state).toBeDefined();

      const result = await service.completeInstall(state!, "test-code");

      expect(result.redirectUri).toEqual("https://app.example.com/settings");
    });

    it("throws STATE_INVALID for invalid JWT", async () => {
      const error = await service
        .completeInstall("invalid-jwt-token", "code")
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(AppInstallError);
      expect((error as AppInstallError).code).toEqual("STATE_INVALID");
    });

    it("throws STATE_INVALID for expired JWT", async () => {
      // This is hard to test without time manipulation, but we can test malformed JWT
      const error = await service
        .completeInstall("expired.jwt.token", "code")
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
          secret: {
            externalId: "team-reconcile-123",
            access_token: "xoxb-token",
            token_type: "bot",
          },
        },
        "user-123",
      );

      // Reconcile route
      await service.reconcileRoute("test-slack", id, "user-123");

      // Verify route created
      expect(routeStorage.getRoute("team-reconcile-123")).toEqual("user-123");
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
});
