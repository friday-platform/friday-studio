import { afterEach, describe, expect, it, vi } from "vitest";
import { hydrateDynamicProvider } from "./dynamic.ts";
import type { DynamicApiKeyProviderInput, DynamicOAuthProviderInput } from "./types.ts";

describe("hydrateDynamicProvider", () => {
  it("apikey: produces correct provider structure", () => {
    const input: DynamicApiKeyProviderInput = {
      type: "apikey",
      id: "test-apikey",
      displayName: "Test API Key Provider",
      description: "A test provider",
      secretSchema: { api_key: "string" },
      setupInstructions: "Enter your API key",
    };

    const provider = hydrateDynamicProvider(input);

    expect(provider.type).toEqual("apikey");
    expect(provider.id).toEqual("test-apikey");
    expect(provider.displayName).toEqual("Test API Key Provider");
    expect(provider.description).toEqual("A test provider");

    if (provider.type !== "apikey") {
      throw new Error("Expected apikey provider");
    }
    expect(provider.setupInstructions).toEqual("Enter your API key");
  });

  it("apikey: builds Zod schema from secretSchema record", () => {
    const input: DynamicApiKeyProviderInput = {
      type: "apikey",
      id: "multi-field",
      displayName: "Multi Field Provider",
      description: "Provider with multiple secret fields",
      secretSchema: { api_key: "string", api_secret: "string", tenant_id: "string" },
    };

    const provider = hydrateDynamicProvider(input);

    if (provider.type !== "apikey") {
      throw new Error("Expected apikey provider");
    }

    // Schema should validate objects with all three fields
    const validSecret = { api_key: "key123", api_secret: "secret456", tenant_id: "tenant789" };
    const result = provider.secretSchema.safeParse(validSecret);
    expect(result.success).toEqual(true);

    // Schema should reject missing fields
    const invalidSecret = { api_key: "key123" };
    const invalidResult = provider.secretSchema.safeParse(invalidSecret);
    expect(invalidResult.success).toEqual(false);
  });

  it("apikey: uses default setupInstructions when not provided", () => {
    const input: DynamicApiKeyProviderInput = {
      type: "apikey",
      id: "default-instructions",
      displayName: "My Provider",
      description: "Test",
      secretSchema: { key: "string" },
      // No setupInstructions
    };

    const provider = hydrateDynamicProvider(input);

    if (provider.type !== "apikey") {
      throw new Error("Expected apikey provider");
    }
    expect(provider.setupInstructions).toEqual("Enter your My Provider API credentials.");
  });

  it("oauth: produces correct provider type and structure", () => {
    const input: DynamicOAuthProviderInput = {
      type: "oauth",
      id: "test-oauth",
      displayName: "Test OAuth Provider",
      description: "OAuth test",
      oauthConfig: {
        mode: "discovery",
        serverUrl: "https://mcp.example.com/v1/mcp",
        scopes: ["read", "write"],
      },
    };

    const provider = hydrateDynamicProvider(input);

    expect(provider.type).toEqual("oauth");
    expect(provider.id).toEqual("test-oauth");
    expect(provider.displayName).toEqual("Test OAuth Provider");
    expect(provider.description).toEqual("OAuth test");

    if (provider.type !== "oauth") {
      throw new Error("Expected oauth provider");
    }
    if (provider.oauthConfig.mode !== "discovery") {
      throw new Error("Expected discovery mode");
    }
    expect(provider.oauthConfig.serverUrl).toEqual("https://mcp.example.com/v1/mcp");
    expect(provider.identify).toBeDefined();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("oauth: identify returns sub from userinfo on success", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/.well-known/oauth-protected-resource")) {
        return Promise.resolve(
          Response.json({ userinfo_endpoint: "https://mcp.example.com/userinfo" }),
        );
      }
      if (url.includes("/userinfo")) {
        return Promise.resolve(Response.json({ sub: "user-123" }));
      }
      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    });

    const input: DynamicOAuthProviderInput = {
      type: "oauth",
      id: "oauth-success",
      displayName: "Success Test",
      description: "Tests userinfo success path",
      oauthConfig: { mode: "discovery", serverUrl: "https://mcp.example.com/v1/mcp" },
    };

    const provider = hydrateDynamicProvider(input);
    if (provider.type !== "oauth") throw new Error("Expected oauth provider");

    const identifier = await provider.identify({
      access_token: "valid-token",
      token_type: "bearer",
    });
    expect(identifier).toEqual("user-123");
  });

  it("oauth: identify falls back to token hash on SSRF origin mismatch", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/.well-known/oauth-protected-resource")) {
        // Return a cross-origin userinfo_endpoint — should be rejected as SSRF
        return Promise.resolve(
          Response.json({ userinfo_endpoint: "https://evil.example.com/userinfo" }),
        );
      }
      // If SSRF protection is broken, code will fetch the evil endpoint — mock success to detect it
      return Promise.resolve(Response.json({ sub: "evil-user" }));
    });

    const input: DynamicOAuthProviderInput = {
      type: "oauth",
      id: "oauth-ssrf",
      displayName: "SSRF Test",
      description: "Tests SSRF origin check",
      oauthConfig: { mode: "discovery", serverUrl: "https://mcp.example.com/v1/mcp" },
    };

    const provider = hydrateDynamicProvider(input);
    if (provider.type !== "oauth") throw new Error("Expected oauth provider");

    const identifier = await provider.identify({
      access_token: "test-token",
      token_type: "bearer",
    });
    // Should fall back to token hash, not return "evil-user"
    expect(identifier.startsWith("token:")).toEqual(true);
    expect(identifier).toHaveLength(6 + 64);

    // Verify the evil endpoint was never fetched
    const evilCalls = fetchSpy.mock.calls.filter(([input]) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      return url.includes("evil.example.com");
    });
    expect(evilCalls).toHaveLength(0);
  });

  it("oauth: identify returns token hash on fetch failure", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("fetch failed"));

    const input: DynamicOAuthProviderInput = {
      type: "oauth",
      id: "oauth-fallback",
      displayName: "Fallback Test",
      description: "Tests token hash fallback",
      oauthConfig: { mode: "discovery", serverUrl: "https://mcp.example.com/v1/mcp" },
    };

    const provider = hydrateDynamicProvider(input);

    if (provider.type !== "oauth") {
      throw new Error("Expected oauth provider");
    }

    const tokens = { access_token: "test-token", token_type: "bearer" };
    const identifier = await provider.identify(tokens);

    // Should return token hash with "token:" prefix
    expect(identifier.startsWith("token:")).toEqual(true);
    // SHA-256 produces 64 hex chars
    expect(identifier.length).toEqual(6 + 64); // "token:" + 64 hex chars
  });
});
