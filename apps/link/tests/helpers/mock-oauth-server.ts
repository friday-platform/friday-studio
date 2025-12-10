/**
 * Mock OAuth Server for Testing
 * Provides OAuth 2.0 server implementation with discovery, registration, token exchange, and userinfo
 */

import type { Hono } from "hono";
import type { Env, Schema } from "hono/types";
import { z } from "zod";

/** Dynamic client registration data */
export type MockClient = { client_id: string; client_secret: string; redirect_uris: string[] };

/** Authorization code data (state -> auth code info) */
export type MockAuthCode = { code: string; redirect_uri: string; access_token: string };

/** Refresh token data */
export type MockRefreshToken = { access_token: string; refresh_token: string };

/**
 * Mock OAuth server state
 */
export type MockOAuthServer = {
  port: number;
  controller: AbortController;
  issuer: string;
  protectedResourceUrl?: string;
  // Dynamic client registration storage
  clients: Map<string, MockClient>;
  // Authorization codes storage (state -> code -> access_token)
  authCodes: Map<string, MockAuthCode>;
  // Refresh tokens storage
  refreshTokens: Map<string, MockRefreshToken>;
  // Track discovery calls
  discoveryCallCount: number;
  registrationCallCount: number;
  // Config
  includeProtectedResource: boolean;
  includeOAuthMetadata: boolean;
  includeUserinfo: boolean;
};

/**
 * Start mock OAuth server that handles discovery, registration, token exchange, and userinfo
 */
export async function startMockOAuthServer(opts: {
  includeProtectedResource?: boolean;
  includeOAuthMetadata?: boolean;
  includeUserinfo?: boolean;
}): Promise<MockOAuthServer> {
  const controller = new AbortController();
  const clients = new Map<string, MockClient>();
  const authCodes = new Map<string, MockAuthCode>();
  const refreshTokens = new Map<string, MockRefreshToken>();
  let discoveryCallCount = 0;
  let registrationCallCount = 0;

  // Use port 0 to let OS assign an available port
  const port = 0;
  let actualPort = 0;
  let issuer = "";
  let serverReady = false;

  // Store opts for use in handler
  const config = {
    includeProtectedResource: opts.includeProtectedResource !== false,
    includeOAuthMetadata: opts.includeOAuthMetadata !== false,
    includeUserinfo: opts.includeUserinfo !== false,
  };

  // Start server (needs to stay in scope for lifecycle)
  void Deno.serve(
    {
      port,
      signal: controller.signal,
      onListen: ({ port: assignedPort }) => {
        actualPort = assignedPort;
        issuer = `http://localhost:${assignedPort}`;
        serverReady = true;
      },
    },
    async (req) => {
      const url = new URL(req.url);

      // Protected Resource Metadata (optional - 404 triggers OIDC fallback)
      if (url.pathname === "/.well-known/oauth-protected-resource") {
        if (!config.includeProtectedResource) {
          return new Response("Not Found", { status: 404 });
        }
        return Response.json({ resource: issuer, authorization_servers: [issuer] });
      }

      // OAuth AS Metadata (required)
      if (url.pathname === "/.well-known/oauth-authorization-server") {
        discoveryCallCount++;
        if (!config.includeOAuthMetadata) {
          return new Response("Not Found", { status: 404 });
        }
        return Response.json({
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          registration_endpoint: `${issuer}/register`,
          userinfo_endpoint: config.includeUserinfo ? `${issuer}/userinfo` : undefined,
        });
      }

      // OIDC Discovery fallback
      if (url.pathname === "/.well-known/openid-configuration") {
        discoveryCallCount++;
        return Response.json({
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          registration_endpoint: `${issuer}/register`,
          userinfo_endpoint: config.includeUserinfo ? `${issuer}/userinfo` : undefined,
        });
      }

      // Dynamic Client Registration (RFC 7591)
      if (url.pathname === "/register" && req.method === "POST") {
        registrationCallCount++;
        const RegistrationBodySchema = z.object({ redirect_uris: z.array(z.string()) });
        const body = RegistrationBodySchema.parse(await req.json());
        const client_id = crypto.randomUUID();
        const client_secret = crypto.randomUUID();
        clients.set(client_id, { client_id, client_secret, redirect_uris: body.redirect_uris });
        return Response.json(
          {
            client_id,
            client_secret,
            client_secret_expires_at: 0, // 0 means never expires (RFC 7591)
            redirect_uris: body.redirect_uris,
          },
          { status: 201 },
        ); // RFC 7591 requires 201 Created
      }

      // Token endpoint (code exchange and refresh)
      if (url.pathname === "/token" && req.method === "POST") {
        const formData = await req.formData();
        const grant_type = formData.get("grant_type");

        if (grant_type === "authorization_code") {
          const code = formData.get("code");
          const redirect_uri = formData.get("redirect_uri");

          if (!code || !redirect_uri) {
            return Response.json({ error: "invalid_request" }, { status: 400 });
          }

          // Find the auth code
          let foundEntry: { state: string; data: MockAuthCode } | undefined;
          for (const [state, data] of authCodes.entries()) {
            if (data.code === code && data.redirect_uri === redirect_uri) {
              foundEntry = { state, data };
              break;
            }
          }

          if (!foundEntry) {
            return Response.json({ error: "invalid_grant" }, { status: 400 });
          }

          authCodes.delete(foundEntry.state); // Single use

          const access_token = foundEntry.data.access_token;
          const refresh_token = crypto.randomUUID();
          const expires_in = 3600;

          // Store refresh token
          refreshTokens.set(refresh_token, { access_token, refresh_token });

          return Response.json({
            access_token,
            refresh_token,
            token_type: "Bearer",
            expires_in,
            scope: "read:user",
          });
        }

        if (grant_type === "refresh_token") {
          const refresh_token = formData.get("refresh_token");

          if (!refresh_token || typeof refresh_token !== "string") {
            return Response.json({ error: "invalid_request" }, { status: 400 });
          }

          const tokenData = refreshTokens.get(refresh_token);

          if (!tokenData) {
            return Response.json({ error: "invalid_grant" }, { status: 400 });
          }

          // Rotate tokens
          const new_access_token = crypto.randomUUID();
          const new_refresh_token = crypto.randomUUID();
          refreshTokens.delete(refresh_token);
          refreshTokens.set(new_refresh_token, {
            access_token: new_access_token,
            refresh_token: new_refresh_token,
          });

          return Response.json({
            access_token: new_access_token,
            refresh_token: new_refresh_token,
            token_type: "Bearer",
            expires_in: 3600,
          });
        }

        return Response.json({ error: "unsupported_grant_type" }, { status: 400 });
      }

      // Userinfo endpoint
      if (url.pathname === "/userinfo" && req.method === "GET") {
        const authHeader = req.headers.get("Authorization");
        if (!authHeader?.startsWith("Bearer ")) {
          return Response.json({ error: "unauthorized" }, { status: 401 });
        }

        const access_token = authHeader.substring(7);
        // Simple mock - return user based on token
        // Use "with_email" suffix to trigger email response, "sub_only" for sub-only
        if (access_token.includes("with_email")) {
          return Response.json({ sub: "user-123", email: "user@example.com" });
        }
        if (access_token.includes("user_2")) {
          return Response.json({ sub: "user-different", email: "user2@example.com" });
        }
        return Response.json({ sub: "user-456" });
      }

      return new Response("Not Found", { status: 404 });
    },
  );

  // Wait for server to be ready and port assigned
  while (!serverReady) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  return {
    port: actualPort,
    controller,
    issuer,
    protectedResourceUrl: issuer,
    clients,
    authCodes,
    refreshTokens,
    discoveryCallCount,
    registrationCallCount,
    includeProtectedResource: config.includeProtectedResource,
    includeOAuthMetadata: config.includeOAuthMetadata,
    includeUserinfo: config.includeUserinfo,
  };
}

/**
 * Complete OAuth flow helper for tests
 * Handles: initiate → extract state → set mock code → callback → parse credential
 */
export async function completeOAuthFlow<E extends Env, S extends Schema, B extends string>(
  app: Hono<E, S, B>,
  mockServer: MockOAuthServer,
  providerId: string,
  opts?: { accessToken?: string; redirectUri?: string },
): Promise<{ credentialId: string; state: string; callbackResponse: Response }> {
  const accessToken = opts?.accessToken ?? "test_access_token";

  // Step 1: Initiate OAuth flow
  const url = opts?.redirectUri
    ? `/v1/oauth/authorize/${providerId}?redirect_uri=${encodeURIComponent(opts.redirectUri)}`
    : `/v1/oauth/authorize/${providerId}`;
  const initiateRes = await app.request(url);

  if (initiateRes.status !== 302) {
    throw new Error(`Failed to initiate OAuth flow: ${initiateRes.status}`);
  }

  const authUrl = initiateRes.headers.get("Location");
  if (!authUrl) {
    throw new Error("No Location header in initiate response");
  }

  // Step 2: Extract state from authorization URL
  const authUrlObj = new URL(authUrl);
  const state = authUrlObj.searchParams.get("state");
  if (!state) {
    throw new Error("No state in authorization URL");
  }

  const redirect_uri = authUrlObj.searchParams.get("redirect_uri");
  if (!redirect_uri) {
    throw new Error("No redirect_uri in authorization URL");
  }

  // Step 3: Register mock auth code with the mock server
  const code = crypto.randomUUID();
  mockServer.authCodes.set(state, { code, redirect_uri, access_token: accessToken });

  // Step 4: Complete OAuth flow via callback
  const callbackResponse = await app.request(`/v1/oauth/callback?code=${code}&state=${state}`);

  if (callbackResponse.status !== 200 && callbackResponse.status !== 302) {
    throw new Error(`Failed to complete OAuth flow: ${callbackResponse.status}`);
  }

  // Step 5: Parse credential ID from response
  let credentialId: string;

  if (callbackResponse.status === 302) {
    // Parse from redirect URL
    const redirectLocation = callbackResponse.headers.get("Location");
    if (!redirectLocation) {
      throw new Error("No Location header in callback response");
    }
    const redirectUrl = new URL(redirectLocation);
    const parsedCredentialId = redirectUrl.searchParams.get("credential_id");
    if (!parsedCredentialId) {
      throw new Error("No credential_id in redirect URL");
    }
    credentialId = parsedCredentialId;
  } else {
    // Parse from JSON response
    const json = await callbackResponse.clone().json();
    const parsed = z.object({ credential_id: z.string() }).parse(json);
    credentialId = parsed.credential_id;
  }

  return { credentialId, state, callbackResponse };
}
