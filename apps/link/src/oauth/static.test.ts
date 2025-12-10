/**
 * Unit tests for static OAuth helper functions
 */

import { assertEquals } from "@std/assert";
import type { OAuthConfig } from "../providers/types.ts";
import { buildStaticAuthServer } from "./static.ts";

Deno.test("buildStaticAuthServer", async (t) => {
  await t.step("builds AuthorizationServer from config", () => {
    const config: Extract<OAuthConfig, { mode: "static" }> = {
      mode: "static",
      authorizationEndpoint: "https://auth.example.com/oauth/authorize",
      tokenEndpoint: "https://auth.example.com/oauth/token",
      userinfoEndpoint: "https://auth.example.com/oauth/userinfo",
      clientId: "test-client-id",
      clientSecret: "test-client-secret",
      clientAuthMethod: "client_secret_post",
      scopes: ["openid", "email"],
    };

    const authServer = buildStaticAuthServer(config);

    assertEquals(authServer.issuer, "https://auth.example.com");
    assertEquals(authServer.authorization_endpoint, "https://auth.example.com/oauth/authorize");
    assertEquals(authServer.token_endpoint, "https://auth.example.com/oauth/token");
    assertEquals(authServer.userinfo_endpoint, "https://auth.example.com/oauth/userinfo");
  });

  await t.step("sets issuer from authorizationEndpoint origin", () => {
    const config: Extract<OAuthConfig, { mode: "static" }> = {
      mode: "static",
      authorizationEndpoint: "https://auth.example.com/v2/authorize",
      tokenEndpoint: "https://auth.example.com/v2/token",
      clientId: "test-client-id",
      clientSecret: "test-client-secret",
      clientAuthMethod: "client_secret_post",
    };

    const authServer = buildStaticAuthServer(config);

    assertEquals(authServer.issuer, "https://auth.example.com");
  });

  await t.step("handles undefined userinfoEndpoint", () => {
    const config: Extract<OAuthConfig, { mode: "static" }> = {
      mode: "static",
      authorizationEndpoint: "https://auth.example.com/authorize",
      tokenEndpoint: "https://auth.example.com/token",
      clientId: "test-client-id",
      clientSecret: "test-client-secret",
      clientAuthMethod: "client_secret_post",
    };

    const authServer = buildStaticAuthServer(config);

    assertEquals(authServer.userinfo_endpoint, undefined);
  });
});
