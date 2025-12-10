import { assert, assertEquals, assertThrows } from "@std/assert";
import { z } from "zod";
import { ProviderRegistry } from "./registry.ts";

Deno.test("ProviderRegistry", async (t) => {
  const mockProvider = {
    id: "test",
    type: "apikey" as const,
    displayName: "Test Provider",
    description: "A test provider",
    setupInstructions: "# Setup",
    secretSchema: z.object({ key: z.string() }),
  };

  await t.step("register() throws on duplicate ID", () => {
    const registry = new ProviderRegistry();
    registry.register(mockProvider);
    assertThrows(() => registry.register(mockProvider), Error, "already registered");
  });

  await t.step("register() accepts oauth provider with oauthConfig", () => {
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
    assert(registry.has("oauth-test"));
    assertEquals(registry.get("oauth-test"), oauthProvider);
  });

  await t.step("discriminates between apikey and oauth providers", () => {
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

    assert(apikey);
    assert(oauth);
    assertEquals(apikey.type, "apikey");
    assertEquals(oauth.type, "oauth");

    // TypeScript narrowing allows type-safe access
    if (apikey.type === "apikey") {
      assert(apikey.secretSchema);
    }
    if (oauth.type === "oauth") {
      assert(oauth.oauthConfig);
    }
  });
});
