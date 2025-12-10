/**
 * OAuth Token Operations
 * Token exchange and refresh using oauth4webapi
 *
 * @module oauth/tokens
 */

import type { ClientRegistration } from "../types.ts";
import type { AuthorizationServer, ClientAuth } from "./client.ts";
import * as oauth from "./client.ts";
import { shouldAllowInsecureForLocalDev } from "./utils.ts";

export interface TokenExchangeResult {
  access_token: string;
  refresh_token?: string;
  expires_at?: number; // Unix timestamp seconds
  scope?: string;
}

/**
 * Exchange authorization code for tokens.
 *
 * @param authServer - Authorization server metadata from discovery
 * @param clientReg - Client registration details
 * @param callbackParams - URL search params from OAuth callback
 * @param redirectUri - Must match the redirect_uri used in authorization request
 * @param codeVerifier - PKCE code verifier from flow initialization
 * @param clientAuth - Client authentication method (defaults to None for dynamic registration)
 * @returns Token exchange result with access token and optional refresh token
 * @throws OAuth2Error if token exchange fails
 */
export async function exchangeAuthorizationCode(
  authServer: oauth.AuthorizationServer,
  clientReg: ClientRegistration,
  callbackParams: URLSearchParams,
  redirectUri: string,
  codeVerifier: string,
  clientAuth: oauth.ClientAuth = oauth.None(),
): Promise<TokenExchangeResult> {
  const client: oauth.Client = { client_id: clientReg.client_id };

  const response = await oauth.authorizationCodeGrantRequest(
    authServer,
    client,
    clientAuth,
    callbackParams,
    redirectUri,
    codeVerifier,
    { [oauth.allowInsecureRequests]: shouldAllowInsecureForLocalDev() },
  );

  const result = await oauth.processAuthorizationCodeResponse(authServer, client, response);

  // oauth4webapi v3 throws on errors, so if we reach here the result is valid

  // Calculate expires_at from expires_in
  const expiresAt = result.expires_in
    ? Math.floor(Date.now() / 1000) + result.expires_in
    : undefined;

  return {
    access_token: result.access_token,
    refresh_token: result.refresh_token,
    expires_at: expiresAt,
    scope: result.scope,
  };
}

/**
 * Refresh access token using refresh token.
 *
 * @param authServer - Authorization server metadata from discovery
 * @param clientReg - Client registration details
 * @param refreshToken - Refresh token from previous token exchange
 * @param clientAuth - Client authentication method (defaults to None for dynamic registration)
 * @returns Token exchange result with new access token
 * @throws OAuth2Error if token refresh fails
 */
export async function refreshAccessToken(
  authServer: oauth.AuthorizationServer,
  clientReg: ClientRegistration,
  refreshToken: string,
  clientAuth: oauth.ClientAuth = oauth.None(),
): Promise<TokenExchangeResult> {
  const client: oauth.Client = { client_id: clientReg.client_id };

  const response = await oauth.refreshTokenGrantRequest(
    authServer,
    client,
    clientAuth,
    refreshToken,
    {
      // Allow HTTP for testing (oauth4webapi requires HTTPS by default)
      [oauth.allowInsecureRequests]: shouldAllowInsecureForLocalDev(),
    },
  );

  const result = await oauth.processRefreshTokenResponse(authServer, client, response);

  // oauth4webapi v3 throws on errors

  // Handle refresh token rotation - some servers return new refresh_token
  const newRefreshToken = result.refresh_token ?? refreshToken;

  // Calculate new expires_at
  const expiresAt = result.expires_in
    ? Math.floor(Date.now() / 1000) + result.expires_in
    : undefined;

  return {
    access_token: result.access_token,
    refresh_token: newRefreshToken,
    expires_at: expiresAt,
    scope: result.scope,
  };
}

/**
 * Revoke an OAuth access or refresh token.
 * Best-effort revocation per RFC 7009 - failures are silently ignored.
 *
 * @param authServer - Authorization server metadata from discovery
 * @param clientReg - Client registration details
 * @param clientAuth - Client authentication method
 * @param token - Access or refresh token to revoke
 */
export async function revokeToken(
  authServer: AuthorizationServer,
  clientReg: { client_id: string },
  clientAuth: ClientAuth,
  token: string,
): Promise<void> {
  if (!authServer.revocation_endpoint) return;
  try {
    const response = await oauth.revocationRequest(authServer, clientReg, clientAuth, token, {
      [oauth.allowInsecureRequests]: shouldAllowInsecureForLocalDev(),
    });
    await oauth.processRevocationResponse(response);
  } catch {
    // Best effort - ignore failures
  }
}
