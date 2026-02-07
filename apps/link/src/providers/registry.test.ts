import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ProviderRegistry } from "./registry.ts";
import { LocalProviderStorageAdapter } from "./storage/local-adapter.ts";
import type { DynamicProviderInput, ProviderDefinition } from "./types.ts";

/**
 * Helper to create a registry with injectable storage adapter for testing.
 * Uses in-memory KV to avoid real storage.
 */
async function createTestRegistry(): Promise<{
  registry: ProviderRegistry;
  adapter: LocalProviderStorageAdapter;
  cleanup: () => Promise<void>;
}> {
  const kv = await Deno.openKv(":memory:");
  const adapter = new LocalProviderStorageAdapter(kv);
  const registry = new ProviderRegistry(adapter);
  return {
    registry,
    adapter,
    cleanup: () => {
      kv.close();
      return Promise.resolve();
    },
  };
}

describe("ProviderRegistry static providers", () => {
  const mockProvider = {
    id: "test",
    type: "apikey" as const,
    displayName: "Test Provider",
    description: "A test provider",
    setupInstructions: "# Setup",
    secretSchema: z.object({ key: z.string() }),
  };

  it("register() throws on duplicate ID", () => {
    const registry = new ProviderRegistry();
    registry.register(mockProvider);
    expect(() => registry.register(mockProvider)).toThrow("already registered");
  });

  it("register() accepts oauth provider with oauthConfig", async () => {
    const { registry, cleanup } = await createTestRegistry();
    try {
      const oauthProvider = {
        id: "oauth-test",
        type: "oauth" as const,
        displayName: "OAuth Test",
        description: "Test OAuth provider",
        setupInstructions: "# OAuth Setup",
        oauthConfig: {
          mode: "discovery" as const,
          serverUrl: "https://mcp.example.com/v1/sse",
          scopes: ["read", "write"],
        },
        identify: () => Promise.resolve("test-user-id"),
      };
      registry.register(oauthProvider);
      expect(registry.has("oauth-test")).toBe(true);
      expect(await registry.get("oauth-test")).toEqual(oauthProvider);
    } finally {
      await cleanup();
    }
  });

  it("discriminates between apikey and oauth providers", async () => {
    const { registry, cleanup } = await createTestRegistry();
    try {
      const apikeyProvider = {
        id: "apikey-test",
        type: "apikey" as const,
        displayName: "API Key Test",
        description: "Test API key provider",
        setupInstructions: "# Setup",
        secretSchema: z.object({ key: z.string() }),
      };
      const oauthProvider = {
        id: "oauth-test",
        type: "oauth" as const,
        displayName: "OAuth Test",
        description: "Test OAuth provider",
        setupInstructions: "# OAuth Setup",
        oauthConfig: { mode: "discovery" as const, serverUrl: "https://mcp.example.com/v1/sse" },
        identify: () => Promise.resolve("test-user-id"),
      };

      registry.register(apikeyProvider);
      registry.register(oauthProvider);

      const apikey = await registry.get("apikey-test");
      const oauth = await registry.get("oauth-test");

      expect(apikey).toBeDefined();
      expect(oauth).toBeDefined();
      if (!apikey || !oauth) throw new Error("Expected both providers to be defined");
      expect(apikey.type).toEqual("apikey");
      expect(oauth.type).toEqual("oauth");

      // TypeScript narrowing allows type-safe access
      if (apikey.type !== "apikey") throw new Error("Expected apikey provider");
      expect(apikey.secretSchema).toBeDefined();
      if (oauth.type !== "oauth") throw new Error("Expected oauth provider");
      expect(oauth.oauthConfig).toBeDefined();
    } finally {
      await cleanup();
    }
  });
});

describe("ProviderRegistry dynamic providers", () => {
  const dynamicApiKeyInput: DynamicProviderInput = {
    type: "apikey",
    id: "dynamic-test",
    displayName: "Dynamic Test",
    description: "A dynamically registered provider",
    secretSchema: { api_key: "string" },
    setupInstructions: "Enter your API key",
  };

  const dynamicOAuthInput: DynamicProviderInput = {
    type: "oauth",
    id: "dynamic-oauth",
    displayName: "Dynamic OAuth",
    description: "A dynamic OAuth provider",
    oauthConfig: { mode: "discovery", serverUrl: "https://mcp.example.com/v1/sse" },
  };

  it("storeDynamicProvider() stores new provider successfully", async () => {
    const { registry, cleanup } = await createTestRegistry();
    try {
      const result = await registry.storeDynamicProvider(dynamicApiKeyInput);
      expect(result).toBe(true);

      // Verify it can be retrieved
      const provider = await registry.get("dynamic-test");
      expect(provider).toBeDefined();
      expect(provider?.id).toEqual("dynamic-test");
      expect(provider?.type).toEqual("apikey");
      expect(provider?.displayName).toEqual("Dynamic Test");
    } finally {
      await cleanup();
    }
  });

  it("storeDynamicProvider() returns false for static conflict", async () => {
    const { registry, cleanup } = await createTestRegistry();
    try {
      // Register a static provider first
      const staticProvider: ProviderDefinition = {
        id: "conflict-test",
        type: "apikey",
        displayName: "Static Provider",
        description: "A static provider",
        setupInstructions: "Setup",
        secretSchema: z.object({ key: z.string() }),
      };
      registry.register(staticProvider);

      // Try to store a dynamic provider with same ID
      const conflictingInput: DynamicProviderInput = {
        type: "apikey",
        id: "conflict-test",
        displayName: "Dynamic Conflict",
        description: "Should fail",
        secretSchema: { key: "string" },
      };

      const result = await registry.storeDynamicProvider(conflictingInput);
      expect(result).toBe(false);

      // Verify static provider is still there unchanged
      const provider = await registry.get("conflict-test");
      expect(provider).toBeDefined();
      expect(provider?.displayName).toEqual("Static Provider");
    } finally {
      await cleanup();
    }
  });

  it("storeDynamicProvider() returns false for dynamic conflict", async () => {
    const { registry, cleanup } = await createTestRegistry();
    try {
      // Store first dynamic provider
      const result1 = await registry.storeDynamicProvider(dynamicApiKeyInput);
      expect(result1).toBe(true);

      // Try to store another with same ID
      const conflictingInput: DynamicProviderInput = {
        type: "apikey",
        id: "dynamic-test",
        displayName: "Second Dynamic",
        description: "Should fail",
        secretSchema: { key: "string" },
      };

      const result2 = await registry.storeDynamicProvider(conflictingInput);
      expect(result2).toBe(false);

      // Verify first one is still there
      const provider = await registry.get("dynamic-test");
      expect(provider).toBeDefined();
      expect(provider?.displayName).toEqual("Dynamic Test");
    } finally {
      await cleanup();
    }
  });

  it("get() returns static providers", async () => {
    const { registry, cleanup } = await createTestRegistry();
    try {
      const staticProvider: ProviderDefinition = {
        id: "static-get-test",
        type: "apikey",
        displayName: "Static Get Test",
        description: "Testing get() for static",
        setupInstructions: "Setup",
        secretSchema: z.object({ key: z.string() }),
      };
      registry.register(staticProvider);

      const provider = await registry.get("static-get-test");
      expect(provider).toBeDefined();
      expect(provider?.id).toEqual("static-get-test");
      expect(provider?.displayName).toEqual("Static Get Test");
    } finally {
      await cleanup();
    }
  });

  it("get() returns dynamic providers from KV", async () => {
    const { registry, cleanup } = await createTestRegistry();
    try {
      await registry.storeDynamicProvider(dynamicOAuthInput);

      const provider = await registry.get("dynamic-oauth");
      expect(provider).toBeDefined();
      expect(provider?.id).toEqual("dynamic-oauth");
      expect(provider?.type).toEqual("oauth");
      expect(provider?.displayName).toEqual("Dynamic OAuth");
      if (provider?.type === "oauth") {
        expect(provider?.oauthConfig.mode).toEqual("discovery");
      }
    } finally {
      await cleanup();
    }
  });

  it("get() returns undefined for non-existent provider", async () => {
    const { registry, cleanup } = await createTestRegistry();
    try {
      const provider = await registry.get("does-not-exist");
      expect(provider).toBeUndefined();
    } finally {
      await cleanup();
    }
  });

  it("list() includes both static and dynamic providers", async () => {
    const { registry, cleanup } = await createTestRegistry();
    try {
      // Register static provider
      const staticProvider: ProviderDefinition = {
        id: "static-list-test",
        type: "apikey",
        displayName: "Static List Test",
        description: "For list testing",
        setupInstructions: "Setup",
        secretSchema: z.object({ key: z.string() }),
      };
      registry.register(staticProvider);

      // Store dynamic providers
      await registry.storeDynamicProvider(dynamicApiKeyInput);
      await registry.storeDynamicProvider(dynamicOAuthInput);

      const providers = await registry.list();

      // Should have all three
      expect(providers.length).toEqual(3);

      const ids = providers.map((p) => p.id).sort();
      expect(ids).toEqual(["dynamic-oauth", "dynamic-test", "static-list-test"]);

      // Verify types are correct
      const staticFromList = providers.find((p) => p.id === "static-list-test");
      const dynamicApiKey = providers.find((p) => p.id === "dynamic-test");
      const dynamicOAuth = providers.find((p) => p.id === "dynamic-oauth");

      expect(staticFromList).toBeDefined();
      expect(dynamicApiKey).toBeDefined();
      expect(dynamicOAuth).toBeDefined();
      expect(staticFromList?.type).toEqual("apikey");
      expect(dynamicApiKey?.type).toEqual("apikey");
      expect(dynamicOAuth?.type).toEqual("oauth");
    } finally {
      await cleanup();
    }
  });

  it("list() returns empty array when no providers", async () => {
    const { registry, cleanup } = await createTestRegistry();
    try {
      const providers = await registry.list();
      expect(providers.length).toEqual(0);
    } finally {
      await cleanup();
    }
  });

  it("get() prioritizes static over dynamic with same ID", async () => {
    const { registry, adapter, cleanup } = await createTestRegistry();
    try {
      // Register static provider
      const staticProvider: ProviderDefinition = {
        id: "priority-test",
        type: "apikey",
        displayName: "Static Priority",
        description: "Should win",
        setupInstructions: "Setup",
        secretSchema: z.object({ key: z.string() }),
      };
      registry.register(staticProvider);

      // Manually insert dynamic with same ID (bypassing storeDynamicProvider check)
      const dynamicInput: DynamicProviderInput = {
        type: "apikey",
        id: "priority-test",
        displayName: "Dynamic Priority",
        description: "Should lose",
        secretSchema: { key: "string" },
      };
      await adapter.add(dynamicInput);

      // get() should return static
      const provider = await registry.get("priority-test");
      expect(provider).toBeDefined();
      expect(provider?.displayName).toEqual("Static Priority");
    } finally {
      await cleanup();
    }
  });
});

describe("ProviderRegistry deleteDynamicProvider", () => {
  it("deletes a dynamic provider", async () => {
    const { registry, cleanup } = await createTestRegistry();
    try {
      const input: DynamicProviderInput = {
        type: "apikey",
        id: "delete-me",
        displayName: "Delete Me",
        description: "To be deleted",
        secretSchema: { api_key: "string" },
      };
      await registry.storeDynamicProvider(input);

      const before = await registry.get("delete-me");
      expect(before).toBeDefined();

      const result = await registry.deleteDynamicProvider("delete-me");
      expect(result).toBe(true);

      const after = await registry.get("delete-me");
      expect(after).toBeUndefined();
    } finally {
      await cleanup();
    }
  });

  it("returns false for static provider", async () => {
    const { registry, cleanup } = await createTestRegistry();
    try {
      registry.register({
        id: "static-nodelete",
        type: "apikey" as const,
        displayName: "Static",
        description: "Cannot delete",
        setupInstructions: "Setup",
        secretSchema: z.object({ key: z.string() }),
      });

      const result = await registry.deleteDynamicProvider("static-nodelete");
      expect(result).toBe(false);
      expect(await registry.get("static-nodelete")).toBeDefined();
    } finally {
      await cleanup();
    }
  });

  it("returns false for non-existent provider", async () => {
    const { registry, cleanup } = await createTestRegistry();
    try {
      const result = await registry.deleteDynamicProvider("does-not-exist");
      expect(result).toBe(false);
    } finally {
      await cleanup();
    }
  });
});
