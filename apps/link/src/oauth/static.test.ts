/**
 * Unit tests for static OAuth helper functions
 */

import { describe, expect, it } from "vitest";
import type { OAuthConfig } from "../providers/types.ts";
import type * as oauth from "./client.ts";
import { buildStaticAuthServer, getStaticClientAuth } from "./static.ts";

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

describe("getStaticClientAuth", () => {
  it("returns ClientSecretPost for client_secret_post method", () => {
    const config: Extract<OAuthConfig, { mode: "static" }> = {
      mode: "static",
      authorizationEndpoint: "https://auth.example.com/authorize",
      tokenEndpoint: "https://auth.example.com/token",
      clientId: "test-client-id",
      clientSecret: "test-client-secret",
      clientAuthMethod: "client_secret_post",
    };

    const auth = getStaticClientAuth(config);
    expect(typeof auth).toBe("function");
  });

  it("returns ClientSecretBasic for client_secret_basic method", () => {
    const config: Extract<OAuthConfig, { mode: "static" }> = {
      mode: "static",
      authorizationEndpoint: "https://auth.example.com/authorize",
      tokenEndpoint: "https://auth.example.com/token",
      clientId: "test-client-id",
      clientSecret: "test-client-secret",
      clientAuthMethod: "client_secret_basic",
    };

    const auth = getStaticClientAuth(config);
    expect(typeof auth).toBe("function");
  });

  it("returns EmptyClientSecretPost for none auth method (sends empty client_secret)", () => {
    const config: Extract<OAuthConfig, { mode: "static" }> = {
      mode: "static",
      authorizationEndpoint: "https://auth.example.com/authorize",
      tokenEndpoint: "https://auth.example.com/token",
      clientId: "test-client-id",
      clientAuthMethod: "none",
    };

    const auth = getStaticClientAuth(config);
    const body = new URLSearchParams();
    auth({} as oauth.AuthorizationServer, { client_id: "test-client-id" }, body, new Headers());

    expect(body.get("client_id")).toBe("test-client-id");
    expect(body.get("client_secret")).toBe("");
  });

  it("returns None when clientSecret is missing without explicit none method", () => {
    const config: Extract<OAuthConfig, { mode: "static" }> = {
      mode: "static",
      authorizationEndpoint: "https://auth.example.com/authorize",
      tokenEndpoint: "https://auth.example.com/token",
      clientId: "test-client-id",
    };

    const auth = getStaticClientAuth(config);
    const body = new URLSearchParams();
    auth({} as oauth.AuthorizationServer, { client_id: "test-client-id" }, body, new Headers());

    expect(body.get("client_id")).toBe("test-client-id");
    expect(body.has("client_secret")).toBe(false);
  });
});
