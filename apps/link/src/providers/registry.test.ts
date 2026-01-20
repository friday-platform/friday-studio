import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ProviderRegistry } from "./registry.ts";

describe("ProviderRegistry", () => {
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

  it("register() accepts oauth provider with oauthConfig", () => {
    const registry = new ProviderRegistry();
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
    expect(registry.get("oauth-test")).toEqual(oauthProvider);
  });

  it("discriminates between apikey and oauth providers", () => {
    const registry = new ProviderRegistry();
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

    const apikey = registry.get("apikey-test");
    const oauth = registry.get("oauth-test");

    expect(apikey).toBeDefined();
    expect(oauth).toBeDefined();
    expect(apikey!.type).toEqual("apikey");
    expect(oauth!.type).toEqual("oauth");

    // TypeScript narrowing allows type-safe access
    if (apikey!.type === "apikey") {
      expect(apikey!.secretSchema).toBeDefined();
    }
    if (oauth!.type === "oauth") {
      expect(oauth!.oauthConfig).toBeDefined();
    }
  });
});
