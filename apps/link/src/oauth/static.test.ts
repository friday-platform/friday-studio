/**
 * Unit tests for static OAuth helper functions
 */

import { describe, expect, it } from "vitest";
import type { OAuthConfig } from "../providers/types.ts";
import { buildStaticAuthServer } from "./static.ts";

describe("buildStaticAuthServer", () => {
  it("builds AuthorizationServer from config", () => {
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

    expect(authServer.issuer).toEqual("https://auth.example.com");
    expect(authServer.authorization_endpoint).toEqual("https://auth.example.com/oauth/authorize");
    expect(authServer.token_endpoint).toEqual("https://auth.example.com/oauth/token");
    expect(authServer.userinfo_endpoint).toEqual("https://auth.example.com/oauth/userinfo");
  });

  it("sets issuer from authorizationEndpoint origin", () => {
    const config: Extract<OAuthConfig, { mode: "static" }> = {
      mode: "static",
      authorizationEndpoint: "https://auth.example.com/v2/authorize",
      tokenEndpoint: "https://auth.example.com/v2/token",
      clientId: "test-client-id",
      clientSecret: "test-client-secret",
      clientAuthMethod: "client_secret_post",
    };

    const authServer = buildStaticAuthServer(config);

    expect(authServer.issuer).toEqual("https://auth.example.com");
  });

  it("handles undefined userinfoEndpoint", () => {
    const config: Extract<OAuthConfig, { mode: "static" }> = {
      mode: "static",
      authorizationEndpoint: "https://auth.example.com/authorize",
      tokenEndpoint: "https://auth.example.com/token",
      clientId: "test-client-id",
      clientSecret: "test-client-secret",
      clientAuthMethod: "client_secret_post",
    };

    const authServer = buildStaticAuthServer(config);

    expect(authServer.userinfo_endpoint).toEqual(undefined);
  });
});
