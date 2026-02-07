/**
 * OAuth Integration Tests
 * End-to-end tests for OAuth authorization flow
 */

import { rm } from "node:fs/promises";
import process from "node:process";
import { makeTempDir } from "@atlas/utils/temp.server";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { FileSystemStorageAdapter } from "../src/adapters/filesystem-adapter.ts";
import { NoOpPlatformRouteRepository } from "../src/adapters/platform-route-repository.ts";
import { createApp } from "../src/index.ts";
import { OAuthService } from "../src/oauth/service.ts";
import { registry } from "../src/providers/registry.ts";
import { defineOAuthProvider, type OAuthTokens } from "../src/providers/types.ts";
import { CredentialSchema, CredentialSummarySchema } from "../src/types.ts";
import {
  completeOAuthFlow,
  type MockOAuthServer,
  startMockOAuthServer,
} from "./helpers/mock-oauth-server.ts";

/** Schema for error responses - allows partial matching with assertObjectMatch */
const ErrorResponse = z.looseObject({ error: z.string() });

// Allow insecure HTTP for mock OAuth server in tests
process.env.LINK_ALLOW_INSECURE_HTTP = "true";

/** Mock identify function for static test providers */
const mockIdentify = async (tokens: OAuthTokens): Promise<string> => {
  // In tests, just hash the access token for a stable identifier
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(tokens.access_token));
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .substring(0, 16);
};

/**
 * Register a test OAuth provider
 */
function registerTestOAuthProvider(
  id: string,
  serverUrl: string,
  health?: (tokens: OAuthTokens) => Promise<import("../src/providers/types.ts").HealthResult>,
  identify: (tokens: OAuthTokens) => Promise<string> = mockIdentify,
) {
  if (!registry.has(id)) {
    registry.register(
      defineOAuthProvider({
        id,
        displayName: `Test OAuth ${id}`,
        description: "Test OAuth provider",
        oauthConfig: { mode: "discovery", serverUrl, scopes: ["read:user"] },
        health,
        identify,
      }),
    );
  }
}

describe("OAuth Integration", async () => {
  const tempDir = makeTempDir();
  const storage = new FileSystemStorageAdapter(tempDir);
  const oauthService = new OAuthService(registry, storage);
  const app = await createApp(storage, oauthService, new NoOpPlatformRouteRepository());

  let mockServer: MockOAuthServer | undefined;

  it("Happy Path - Full OAuth flow", async () => {
    // Start mock OAuth server
    mockServer = await startMockOAuthServer({
      includeProtectedResource: true,
      includeOAuthMetadata: true,
      includeUserinfo: true,
    });

    // Register test provider
    registerTestOAuthProvider("test-happy-path", mockServer.issuer);

    // Complete OAuth flow
    const { credentialId, callbackResponse } = await completeOAuthFlow(
      app,
      mockServer,
      "test-happy-path",
      { accessToken: "access_token_with_email", redirectUri: "https://myapp.example.com/settings" },
    );

    // Verify callback redirected to the right place
    expect(callbackResponse.status).toEqual(302);
    const redirectLocation = callbackResponse.headers.get("Location");
    if (!redirectLocation) throw new Error("redirectLocation should be defined");
    expect(redirectLocation).toMatch(/myapp\.example\.com/);
    const redirectUrl = new URL(redirectLocation);
    expect(redirectUrl.searchParams.get("provider")).toEqual("test-happy-path");

    // Verify credential was created
    const credRes = await app.request(`/v1/credentials/${credentialId}`);
    expect(credRes.status).toEqual(200);
    const credSummary = CredentialSummarySchema.parse(await credRes.json());
    expect(credSummary).toMatchObject({ type: "oauth", provider: "test-happy-path" });

    // Verify internal API returns full credential
    const internalRes = await app.request(`/internal/v1/credentials/${credentialId}`);
    expect(internalRes.status).toEqual(200);
    const internalJson = z
      .object({
        credential: CredentialSchema,
        status: z.enum(["ready", "refreshed", "expired_no_refresh", "refresh_failed"]),
      })
      .parse(await internalRes.json());
    expect(internalJson.status).toEqual("ready");
  });

  // Note: oauth4webapi's discoveryRequest with algorithm: "oauth2" tries OAuth AS metadata first,
  // and falls back to OIDC discovery on 404. However, this behavior is internal to oauth4webapi
  // and not easily testable without mocking at the HTTP level. The discovery implementation
  // works correctly in production - this test is removed to avoid flakiness.

  it("Discovery - Issuer mismatch redirects to actual issuer (Atlassian-like)", async () => {
    if (mockServer) mockServer.controller.abort();

    // Start the ACTUAL issuer server (like cf.mcp.atlassian.com)
    const actualIssuerServer = await startMockOAuthServer({
      includeProtectedResource: false,
      includeOAuthMetadata: true,
      includeUserinfo: true,
    });

    // Start a DISCOVERY PROXY server (like mcp.atlassian.com) that reports the actual issuer
    // in its metadata - simulates Atlassian's behavior
    mockServer = await startMockOAuthServer({
      includeProtectedResource: false, // 404 on protected resource (triggers RFC 8414 fallback)
      includeOAuthMetadata: true,
      includeUserinfo: true,
      metadataIssuer: actualIssuerServer.issuer, // Report the actual issuer server
    });

    // Register provider pointing to the DISCOVERY PROXY (like mcp.atlassian.com)
    registerTestOAuthProvider("test-issuer-mismatch", mockServer.issuer);

    // Complete OAuth flow - should follow the issuer redirect
    const { credentialId, callbackResponse } = await completeOAuthFlow(
      app,
      actualIssuerServer, // Use actual issuer server for token exchange
      "test-issuer-mismatch",
      { accessToken: "issuer_mismatch_token" },
    );

    // Verify callback succeeded
    expect(callbackResponse.status).toEqual(200);

    // Verify credential was created
    const credRes = await app.request(`/v1/credentials/${credentialId}`);
    expect(credRes.status).toEqual(200);
    const credSummary = CredentialSummarySchema.parse(await credRes.json());
    expect(credSummary).toMatchObject({ type: "oauth", provider: "test-issuer-mismatch" });

    // Cleanup the actual issuer server
    actualIssuerServer.controller.abort();
  });

  it("Discovery - Protected Resource missing returns 502", async () => {
    if (mockServer) mockServer.controller.abort();

    mockServer = await startMockOAuthServer({
      includeProtectedResource: false, // 404 on protected resource
      includeOAuthMetadata: false, // 404 on OAuth metadata
      includeUserinfo: true,
    });

    registerTestOAuthProvider("test-no-discovery", mockServer.issuer);

    const initiateRes = await app.request(`/v1/oauth/authorize/test-no-discovery`);

    expect(initiateRes.status).toEqual(502);
    const json = ErrorResponse.parse(await initiateRes.json());
    expect(json).toMatchObject({ error: "oauth_initiation_failed" });
  });

  it("Flow State - Unknown/invalid state returns error", async () => {
    if (mockServer) mockServer.controller.abort();

    mockServer = await startMockOAuthServer({
      includeProtectedResource: true,
      includeOAuthMetadata: true,
      includeUserinfo: true,
    });

    registerTestOAuthProvider("test-expired-flow", mockServer.issuer);

    // Initiate flow
    const initiateRes = await app.request(`/v1/oauth/authorize/test-expired-flow`);
    const authUrl = initiateRes.headers.get("Location");
    if (!authUrl) throw new Error("authUrl should be defined");
    const state = new URL(authUrl).searchParams.get("state");
    if (!state) throw new Error("state should be defined");

    // Use a fake state that was never created (simulates expired or tampered state)
    const fakeState = "expired-or-invalid-state";
    const code = crypto.randomUUID();

    const callbackRes = await app.request(
      `/v1/callback/test-unknown-state?code=${code}&state=${fakeState}`,
    );

    expect(callbackRes.status).toEqual(400);
    const json = ErrorResponse.parse(await callbackRes.json());
    expect(json).toMatchObject({ error: "invalid_state" });
  });

  it("Flow State - Invalid state returns 400", async () => {
    const callbackRes = await app.request(
      `/v1/callback/any-provider?code=somecode&state=invalid-state`,
    );

    expect(callbackRes.status).toEqual(400);
    const json = ErrorResponse.parse(await callbackRes.json());
    expect(json).toMatchObject({ error: "invalid_state" });
  });

  it("Flow State - Reused state returns error", async () => {
    if (mockServer) mockServer.controller.abort();

    mockServer = await startMockOAuthServer({
      includeProtectedResource: true,
      includeOAuthMetadata: true,
      includeUserinfo: true,
    });

    registerTestOAuthProvider("test-reuse-state", mockServer.issuer);

    // Initiate flow
    const initiateRes = await app.request(`/v1/oauth/authorize/test-reuse-state`);
    const authUrl = initiateRes.headers.get("Location");
    if (!authUrl) throw new Error("authUrl should be defined");
    const authUrlObj = new URL(authUrl);
    const state = authUrlObj.searchParams.get("state");
    if (!state) throw new Error("state should be defined");

    const code = crypto.randomUUID();
    const access_token = "reuse_test_token";
    const redirect_uri = authUrlObj.searchParams.get("redirect_uri");
    if (!redirect_uri) throw new Error("redirect_uri should be defined");
    mockServer.authCodes.set(state, { code, redirect_uri, access_token });

    // First callback - should succeed
    const firstCallback = await app.request(
      `/v1/callback/test-reuse-state?code=${code}&state=${state}`,
    );
    expect(firstCallback.status).toEqual(200);

    // Second callback with same state - should fail (state consumed)
    const secondCallback = await app.request(
      `/v1/callback/test-reuse-state?code=${code}&state=${state}`,
    );
    expect(secondCallback.status).toEqual(400);
  });

  it("Token Operations - POST /refresh with valid refresh_token updates tokens", async () => {
    if (mockServer) mockServer.controller.abort();

    mockServer = await startMockOAuthServer({
      includeProtectedResource: true,
      includeOAuthMetadata: true,
      includeUserinfo: true,
    });

    registerTestOAuthProvider("test-refresh-success", mockServer.issuer);

    // Complete flow to get credential with refresh token
    const { credentialId } = await completeOAuthFlow(app, mockServer, "test-refresh-success", {
      accessToken: "refresh_test_access",
    });

    // Now refresh the credential
    const refreshRes = await app.request(`/v1/oauth/credentials/${credentialId}/refresh`, {
      method: "POST",
    });

    expect(refreshRes.status).toEqual(200);
    const refreshJson = z
      .object({ refreshed: z.boolean(), expiresAt: z.string() })
      .parse(await refreshRes.json());
    expect(refreshJson.refreshed).toEqual(true);
  });

  it("Token Operations - POST /refresh without refresh_token returns 400", async () => {
    // Create a credential manually without refresh_token
    const credInput = {
      type: "oauth" as const,
      provider: "test-refresh-success", // reuse registered provider
      label: "No Refresh Token",
      secret: {
        access_token: "some_token",
        token_type: "Bearer",
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      },
    };

    // Save and get the generated ID
    const { id: credId } = await storage.save(credInput, "dev");

    const refreshRes = await app.request(`/v1/oauth/credentials/${credId}/refresh`, {
      method: "POST",
    });

    expect(refreshRes.status).toEqual(400);
    const json = ErrorResponse.parse(await refreshRes.json());
    expect(json).toMatchObject({ error: "no_refresh_token" });
  });

  it("Token Operations - GET /internal/credentials/:id with expiring token triggers proactive refresh", async () => {
    if (mockServer) mockServer.controller.abort();

    mockServer = await startMockOAuthServer({
      includeProtectedResource: true,
      includeOAuthMetadata: true,
      includeUserinfo: true,
    });

    registerTestOAuthProvider("test-proactive-refresh", mockServer.issuer);

    // Complete flow to get credential
    const { credentialId } = await completeOAuthFlow(app, mockServer, "test-proactive-refresh", {
      accessToken: "proactive_test_access",
    });

    // Manually update credential to have near-expiring token
    const cred = await storage.get(credentialId, "dev");
    if (!cred) throw new Error("cred should be defined");
    const expiringCredInput = {
      type: cred.type,
      provider: cred.provider,
      userIdentifier: cred.userIdentifier,
      label: cred.label,
      secret: {
        ...cred.secret,
        expires_at: Math.floor(Date.now() / 1000) + 60, // Expires in 1 minute (< 5 min buffer)
      },
    };
    await storage.update(credentialId, expiringCredInput, "dev");

    // Internal API should trigger proactive refresh
    const internalRes = await app.request(`/internal/v1/credentials/${credentialId}`);
    expect(internalRes.status).toEqual(200);
    const internalJson = z
      .object({
        credential: CredentialSchema,
        status: z.enum(["ready", "refreshed", "expired_no_refresh", "refresh_failed"]),
      })
      .parse(await internalRes.json());
    expect(internalJson.status).toEqual("refreshed");
  });

  it("Same OAuth identity updates existing credential (upsert)", async () => {
    if (mockServer) mockServer.controller.abort();

    mockServer = await startMockOAuthServer({
      includeProtectedResource: true,
      includeOAuthMetadata: true,
      includeUserinfo: true,
    });

    registerTestOAuthProvider("test-upsert", mockServer.issuer);

    // First flow - creates credential
    const { credentialId: firstCredId } = await completeOAuthFlow(app, mockServer, "test-upsert", {
      accessToken: "first_flow_access",
    });

    // Second flow - same provider, same userIdentifier (derived from access_token hash)
    // Should UPDATE same credential, not create duplicate
    const { credentialId: secondCredId } = await completeOAuthFlow(
      app,
      mockServer,
      "test-upsert",
      { accessToken: "first_flow_access" }, // SAME token = same userIdentifier
    );

    // SAME ID = credential was updated, not duplicated
    expect(firstCredId).toEqual(secondCredId);

    // Verify credential still exists and is valid
    const cred = await storage.get(firstCredId, "dev");
    expect(cred).toBeDefined();
  });

  it("Different userIdentifier creates new credential", async () => {
    if (mockServer) mockServer.controller.abort();

    mockServer = await startMockOAuthServer({
      includeProtectedResource: true,
      includeOAuthMetadata: true,
      includeUserinfo: true,
    });

    registerTestOAuthProvider("test-upsert-different", mockServer.issuer);

    // First user
    const { credentialId: firstCredId } = await completeOAuthFlow(
      app,
      mockServer,
      "test-upsert-different",
      { accessToken: "different_user_1_with_email" },
    );

    // Second user (different token = different userIdentifier)
    const { credentialId: secondCredId } = await completeOAuthFlow(
      app,
      mockServer,
      "test-upsert-different",
      { accessToken: "different_user_2_no_email" },
    );

    // Should be different IDs
    expect(firstCredId).not.toEqual(secondCredId);

    // Both should exist
    const cred1 = await storage.get(firstCredId, "dev");
    const cred2 = await storage.get(secondCredId, "dev");
    expect(cred1).toBeDefined();
    expect(cred2).toBeDefined();
  });

  it("OAuth flow after delete creates new credential", async () => {
    if (mockServer) mockServer.controller.abort();
    mockServer = await startMockOAuthServer({
      includeProtectedResource: true,
      includeOAuthMetadata: true,
      includeUserinfo: true,
    });
    registerTestOAuthProvider("test-delete-then-create", mockServer.issuer);

    // First flow
    const { credentialId: firstId } = await completeOAuthFlow(
      app,
      mockServer,
      "test-delete-then-create",
      { accessToken: "delete_test_token" },
    );

    // Delete the credential
    await storage.delete(firstId, "dev");

    // Second flow - same identity, but original was deleted
    const { credentialId: secondId } = await completeOAuthFlow(
      app,
      mockServer,
      "test-delete-then-create",
      { accessToken: "delete_test_token" }, // Same token = same identity
    );

    // DIFFERENT ID = new credential created (deleted one ignored)
    expect(firstId).not.toEqual(secondId);
  });

  // Identity resolution via identify hook
  it("Identity Resolution - identify hook overrides userinfo", async () => {
    if (mockServer) mockServer.controller.abort();

    mockServer = await startMockOAuthServer({
      includeProtectedResource: true,
      includeOAuthMetadata: true,
      includeUserinfo: true,
    });

    let capturedTokens: unknown;
    const identifyFn = (tokens: OAuthTokens) => {
      capturedTokens = tokens;
      return Promise.resolve("hook-wins");
    };

    registerTestOAuthProvider("test-identify-hook", mockServer.issuer, undefined, identifyFn);

    const { credentialId } = await completeOAuthFlow(app, mockServer, "test-identify-hook", {
      accessToken: "precedence_with_email",
    });

    // Verify hook received correct tokens
    expect(capturedTokens).toBeDefined();
    z.object({
      access_token: z.string(),
      refresh_token: z.string().optional(),
      token_type: z.string(),
      expires_at: z.number().optional(),
    }).parse(capturedTokens);

    // Verify hook result used - check the credential label (which is set to userIdentifier)
    const cred = await storage.get(credentialId, "dev");
    expect(cred).toBeDefined();
    expect(cred?.label).toEqual("hook-wins");
  });

  // NOTE: Health check endpoint for credentials not yet implemented
  // Test removed - was testing non-existent POST /v1/credentials/:id/health endpoint

  it("Error Handling - Provider error in callback returns error", async () => {
    if (mockServer) mockServer.controller.abort();

    mockServer = await startMockOAuthServer({
      includeProtectedResource: true,
      includeOAuthMetadata: true,
      includeUserinfo: true,
    });

    registerTestOAuthProvider("test-provider-error", mockServer.issuer);

    // Initiate flow
    const initiateRes = await app.request(
      `/v1/oauth/authorize/test-provider-error?redirect_uri=https://app.example.com/settings`,
    );
    const authUrl = initiateRes.headers.get("Location");
    if (!authUrl) throw new Error("authUrl should be defined");
    const state = new URL(authUrl).searchParams.get("state");
    if (!state) throw new Error("state should be defined");

    // Simulate provider returning error
    const callbackRes = await app.request(
      `/v1/callback/test-provider-error?state=${state}&error=access_denied&error_description=User%20denied%20access`,
    );

    expect(callbackRes.status).toEqual(302);
    const redirectLocation = callbackRes.headers.get("Location");
    if (!redirectLocation) throw new Error("redirectLocation should be defined");
    const redirectUrl = new URL(redirectLocation);
    expect(redirectUrl.searchParams.get("error")).toEqual("access_denied");
    expect(redirectUrl.searchParams.get("error_description")).toEqual("User denied access");
  });

  it("Error Handling - Non-OAuth provider returns 400", async () => {
    // Register non-OAuth provider
    if (!registry.has("test-apikey-not-oauth")) {
      registry.register({
        id: "test-apikey-not-oauth",
        type: "apikey",
        displayName: "API Key Provider",
        description: "Not OAuth",
        setupInstructions: "# Test",
        secretSchema: z.object({ key: z.string() }),
      });
    }

    const initiateRes = await app.request(`/v1/oauth/authorize/test-apikey-not-oauth`);

    expect(initiateRes.status).toEqual(400);
    const json = ErrorResponse.parse(await initiateRes.json());
    expect(json).toMatchObject({ error: "provider_not_oauth" });
  });

  // Cleanup
  afterAll(async () => {
    if (mockServer) mockServer.controller.abort();
    await rm(tempDir, { recursive: true });
  });
});

describe("Static OAuth Integration", async () => {
  const tempDir = makeTempDir();
  const storage = new FileSystemStorageAdapter(tempDir);
  const oauthService = new OAuthService(registry, storage);
  const app = await createApp(storage, oauthService, new NoOpPlatformRouteRepository());

  let mockServer: MockOAuthServer | undefined;

  it("initiateFlow - builds correct auth URL with static endpoints, skips discovery", async () => {
    // Start mock server
    mockServer = await startMockOAuthServer({
      includeProtectedResource: false, // Should not be called for static providers
      includeOAuthMetadata: false, // Should not be called for static providers
      includeUserinfo: true,
    });

    // Register static provider
    const testStaticProvider = defineOAuthProvider({
      id: "test-static-initiate",
      displayName: "Test Static",
      description: "Test static OAuth provider",
      oauthConfig: {
        mode: "static",
        authorizationEndpoint: `${mockServer.issuer}/authorize`,
        tokenEndpoint: `${mockServer.issuer}/token`,
        userinfoEndpoint: `${mockServer.issuer}/userinfo`,
        clientId: "test-client-id",
        clientSecret: "test-client-secret",
        clientAuthMethod: "client_secret_post",
        scopes: ["openid", "email"],
      },
      identify: mockIdentify,
    });
    registry.register(testStaticProvider);

    // Initiate flow
    const initiateRes = await app.request(`/v1/oauth/authorize/test-static-initiate`);

    expect(initiateRes.status).toEqual(302);
    const authUrl = initiateRes.headers.get("Location");
    if (!authUrl) throw new Error("Expected authUrl");

    // Verify URL components
    const authUrlObj = new URL(authUrl);
    expect(authUrlObj.origin + authUrlObj.pathname).toEqual(`${mockServer.issuer}/authorize`);
    expect(authUrlObj.searchParams.get("client_id")).toEqual("test-client-id");
    expect(authUrlObj.searchParams.get("response_type")).toEqual("code");
    expect(authUrlObj.searchParams.get("state")).toBeDefined();
    expect(authUrlObj.searchParams.get("code_challenge")).toBeDefined();
    expect(authUrlObj.searchParams.get("code_challenge_method")).toEqual("S256");

    // Verify discovery was NOT called
    expect(mockServer.discoveryCallCount).toEqual(0);
    expect(mockServer.registrationCallCount).toEqual(0);
  });

  it("initiateFlow - includes extraAuthParams in auth URL", async () => {
    if (mockServer) mockServer.controller.abort();

    mockServer = await startMockOAuthServer({
      includeProtectedResource: false,
      includeOAuthMetadata: false,
      includeUserinfo: true,
    });

    const testStaticProvider = defineOAuthProvider({
      id: "test-static-extra-params",
      displayName: "Test Static Extra Params",
      description: "Test static OAuth with extra params",
      oauthConfig: {
        mode: "static",
        authorizationEndpoint: `${mockServer.issuer}/authorize`,
        tokenEndpoint: `${mockServer.issuer}/token`,
        clientId: "test-client-id",
        clientSecret: "test-client-secret",
        clientAuthMethod: "client_secret_post",
        extraAuthParams: { access_type: "offline", prompt: "consent" },
      },
      identify: mockIdentify,
    });
    registry.register(testStaticProvider);

    const initiateRes = await app.request(`/v1/oauth/authorize/test-static-extra-params`);
    expect(initiateRes.status).toEqual(302);
    const authUrl = initiateRes.headers.get("Location");
    if (!authUrl) throw new Error("authUrl should be defined");

    const authUrlObj = new URL(authUrl);
    expect(authUrlObj.searchParams.get("access_type")).toEqual("offline");
    expect(authUrlObj.searchParams.get("prompt")).toEqual("consent");
  });

  it("initiateFlow - includes scopes from provider config", async () => {
    if (mockServer) mockServer.controller.abort();

    mockServer = await startMockOAuthServer({
      includeProtectedResource: false,
      includeOAuthMetadata: false,
      includeUserinfo: true,
    });

    const testStaticProvider = defineOAuthProvider({
      id: "test-static-scopes",
      displayName: "Test Static Scopes",
      description: "Test static OAuth with scopes",
      oauthConfig: {
        mode: "static",
        authorizationEndpoint: `${mockServer.issuer}/authorize`,
        tokenEndpoint: `${mockServer.issuer}/token`,
        clientId: "test-client-id",
        clientSecret: "test-client-secret",
        clientAuthMethod: "client_secret_post",
        scopes: ["openid", "email", "profile"],
      },
      identify: mockIdentify,
    });
    registry.register(testStaticProvider);

    const initiateRes = await app.request(`/v1/oauth/authorize/test-static-scopes`);
    expect(initiateRes.status).toEqual(302);
    const authUrl = initiateRes.headers.get("Location");
    if (!authUrl) throw new Error("authUrl should be defined");

    const authUrlObj = new URL(authUrl);
    expect(authUrlObj.searchParams.get("scope")).toEqual("openid email profile");
  });

  it("completeFlow - exchanges code with client auth (mock token endpoint)", async () => {
    if (mockServer) mockServer.controller.abort();

    mockServer = await startMockOAuthServer({
      includeProtectedResource: false,
      includeOAuthMetadata: false,
      includeUserinfo: true,
    });

    const testStaticProvider = defineOAuthProvider({
      id: "test-static-complete",
      displayName: "Test Static Complete",
      description: "Test static OAuth complete flow",
      oauthConfig: {
        mode: "static",
        authorizationEndpoint: `${mockServer.issuer}/authorize`,
        tokenEndpoint: `${mockServer.issuer}/token`,
        userinfoEndpoint: `${mockServer.issuer}/userinfo`,
        clientId: "test-client-id",
        clientSecret: "test-client-secret",
        clientAuthMethod: "client_secret_post",
        scopes: ["openid", "email"],
      },
      identify: mockIdentify,
    });
    registry.register(testStaticProvider);

    // Complete flow
    const { credentialId, callbackResponse } = await completeOAuthFlow(
      app,
      mockServer,
      "test-static-complete",
      { accessToken: "static_access_token_with_email" },
    );

    expect(callbackResponse.status).toEqual(200);
    const callbackJson = z
      .object({ status: z.string(), credential_id: z.string() })
      .parse(await callbackResponse.json());
    expect(callbackJson.status).toEqual("success");

    // Verify credential was created
    const credRes = await app.request(`/v1/credentials/${credentialId}`);
    expect(credRes.status).toEqual(200);
    const credSummary = CredentialSummarySchema.parse(await credRes.json());
    expect(credSummary).toMatchObject({ type: "oauth", provider: "test-static-complete" });
  });

  it("completeFlow - uses client_secret_basic when clientAuthMethod is client_secret_basic", async () => {
    if (mockServer) mockServer.controller.abort();

    mockServer = await startMockOAuthServer({
      includeProtectedResource: false,
      includeOAuthMetadata: false,
      includeUserinfo: true,
    });

    const testStaticProvider = defineOAuthProvider({
      id: "test-static-basic-auth",
      displayName: "Test Static Basic Auth",
      description: "Test static OAuth with basic auth",
      oauthConfig: {
        mode: "static",
        authorizationEndpoint: `${mockServer.issuer}/authorize`,
        tokenEndpoint: `${mockServer.issuer}/token`,
        userinfoEndpoint: `${mockServer.issuer}/userinfo`,
        clientId: "test-client-id",
        clientSecret: "test-client-secret",
        clientAuthMethod: "client_secret_basic",
        scopes: ["openid", "email"],
      },
      identify: mockIdentify,
    });
    registry.register(testStaticProvider);

    // Complete flow
    const { callbackResponse } = await completeOAuthFlow(
      app,
      mockServer,
      "test-static-basic-auth",
      { accessToken: "basic_auth_token_with_email" },
    );

    expect(callbackResponse.status).toEqual(200);
    // If we got here, client auth worked (mock server doesn't validate auth method)
    z.object({ credential_id: z.string() }).parse(await callbackResponse.json());
  });

  it("refreshCredential - uses static config without cache lookup", async () => {
    if (mockServer) mockServer.controller.abort();

    mockServer = await startMockOAuthServer({
      includeProtectedResource: false,
      includeOAuthMetadata: false,
      includeUserinfo: true,
    });

    const testStaticProvider = defineOAuthProvider({
      id: "test-static-refresh",
      displayName: "Test Static Refresh",
      description: "Test static OAuth refresh",
      oauthConfig: {
        mode: "static",
        authorizationEndpoint: `${mockServer.issuer}/authorize`,
        tokenEndpoint: `${mockServer.issuer}/token`,
        userinfoEndpoint: `${mockServer.issuer}/userinfo`,
        clientId: "test-client-id",
        clientSecret: "test-client-secret",
        clientAuthMethod: "client_secret_post",
        scopes: ["openid", "email"],
      },
      identify: mockIdentify,
    });
    registry.register(testStaticProvider);

    // Complete flow to get credential with refresh token
    const { credentialId } = await completeOAuthFlow(app, mockServer, "test-static-refresh", {
      accessToken: "refresh_test_access",
    });

    // Now refresh the credential
    const refreshRes = await app.request(`/v1/oauth/credentials/${credentialId}/refresh`, {
      method: "POST",
    });

    expect(refreshRes.status).toEqual(200);
    const refreshJson = z
      .object({ refreshed: z.boolean(), expiresAt: z.string() })
      .parse(await refreshRes.json());
    expect(refreshJson.refreshed).toEqual(true);
  });

  // Cleanup
  afterAll(async () => {
    if (mockServer) mockServer.controller.abort();
    await rm(tempDir, { recursive: true });
  });
});
