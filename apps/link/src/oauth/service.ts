/**
 * OAuth Service
 * Main integration point for all OAuth operations
 *
 * @module oauth/service
 */

import { logger } from "@atlas/logger";
import type { ProviderRegistry } from "../providers/registry.ts";
import type { OAuthProvider } from "../providers/types.ts";
import type { ClientRegistration, OAuthCredential, StorageAdapter } from "../types.ts";
import * as oauth from "./client.ts";
import {
  buildDelegatedAuthUrl,
  parseDelegatedCallback,
  refreshDelegatedToken,
} from "./delegated.ts";
import { discoverAuthorizationServer } from "./discovery.ts";
import { decodeState, encodeState, type StatePayload } from "./jwt-state.ts";
import { registerClient } from "./registration.ts";
import { buildStaticAuthServer, getStaticClientAuth } from "./static.ts";
import {
  exchangeAuthorizationCode,
  refreshAccessToken,
  type TokenExchangeResult,
} from "./tokens.ts";

/**
 * OAuth service error
 */
class OAuthServiceError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "OAuthServiceError";
  }
}

/**
 * OAuthService orchestrates OAuth flows end-to-end.
 * Integrates discovery, registration, token exchange, and credential storage.
 */
export class OAuthService {
  private refreshLocks = new Map<string, Promise<OAuthCredential>>();

  constructor(
    private registry: ProviderRegistry,
    private storage: StorageAdapter,
  ) {}

  /**
   * Initiate OAuth authorization flow.
   * Generates authorization URL and stores pending flow state for callback.
   *
   * @param providerId - Provider ID from registry
   * @param callbackUrl - Redirect URI where authorization codes will be sent
   * @param redirectUri - Optional user redirect after successful auth (if undefined, returns JSON)
   * @param scopes - Optional array of OAuth scopes to request
   * @param userId - User ID for multi-tenant credential storage
   * @returns Authorization URL and state parameter
   * @throws {OAuthServiceError} If provider not found, not OAuth type, or discovery/registration fails
   *
   * @example
   * ```ts
   * const { authorizationUrl, state } = await service.initiateFlow(
   *   "github",
   *   "https://link.example.com/oauth/callback",
   *   "https://myapp.example.com/settings",
   *   ["user:email", "repo"],
   *   "user-123"
   * );
   * // redirect user to authorizationUrl
   * ```
   */
  async initiateFlow(
    providerId: string,
    callbackUrl: string,
    redirectUri?: string,
    scopes?: string[],
    userId?: string,
  ): Promise<{ authorizationUrl: string; state: string }> {
    // 1. Get provider from registry, verify OAuth type
    const provider = await this.registry.get(providerId);
    if (!provider) {
      throw new OAuthServiceError("PROVIDER_NOT_FOUND", `Provider '${providerId}' not found`);
    }
    if (provider.type !== "oauth") {
      throw new OAuthServiceError(
        "INVALID_PROVIDER_TYPE",
        `Provider '${providerId}' is not an OAuth provider`,
      );
    }

    const config = provider.oauthConfig;

    // Delegated mode: external endpoint owns the secret and exchanges
    // the code. No PKCE (we don't see the code), no discovery, no
    // registration. The JWT state doubles as the CSRF token that the
    // exchange endpoint echoes back on the final redirect.
    if (config.mode === "delegated") {
      const state = await encodeState({
        // No codeVerifier — PKCE is moot when we don't perform code exchange.
        v: "",
        p: providerId,
        c: callbackUrl,
        r: redirectUri,
        u: userId,
      });

      const authorizationUrl = buildDelegatedAuthUrl(config, state, callbackUrl, scopes);
      return { authorizationUrl, state };
    }

    // 2. Branch on config mode for discovery vs static
    let authServer: oauth.AuthorizationServer;
    let clientReg: ClientRegistration;

    if (config.mode === "static") {
      // Static mode: build authServer from config, no discovery/registration
      authServer = buildStaticAuthServer(config);
      clientReg = { client_id: config.clientId, redirect_uris: [callbackUrl] };
    } else {
      // Discovery mode: fresh discovery and registration on each flow
      authServer = await discoverAuthorizationServer(config.serverUrl);
      const client = await registerClient(authServer, callbackUrl);
      clientReg = {
        client_id: client.client_id,
        client_secret: typeof client.client_secret === "string" ? client.client_secret : undefined,
        redirect_uris: [callbackUrl],
        token_endpoint_auth_method: "none",
      };
    }

    // 4. Build authorization URL manually
    if (!authServer.authorization_endpoint) {
      throw new OAuthServiceError(
        "NO_AUTHORIZATION_ENDPOINT",
        `Authorization server for '${providerId}' has no authorization_endpoint`,
      );
    }

    // 5. Generate PKCE
    const codeVerifier = oauth.generateRandomCodeVerifier();
    const codeChallenge = await oauth.calculatePKCECodeChallenge(codeVerifier);

    // 6. Generate state as signed JWT containing flow data
    const state = await encodeState({
      v: codeVerifier,
      p: providerId,
      c: callbackUrl,
      r: redirectUri,
      u: userId,
      i: config.mode === "discovery" ? clientReg.client_id : undefined,
    });

    const url = new URL(authServer.authorization_endpoint);
    url.searchParams.set("client_id", clientReg.client_id);
    url.searchParams.set("redirect_uri", callbackUrl);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");

    // Use provided scopes or fall back to provider config scopes
    const scopesToUse = scopes?.length ? scopes : config.scopes;
    if (scopesToUse?.length) {
      url.searchParams.set("scope", scopesToUse.join(" "));
    }

    // Add extra auth params for static mode
    if (config.mode === "static" && config.extraAuthParams) {
      for (const [key, value] of Object.entries(config.extraAuthParams)) {
        url.searchParams.set(key, value);
      }
    }

    // 7. Return authorization URL and state (state is self-contained JWT)
    return { authorizationUrl: url.toString(), state };
  }

  /**
   * Complete OAuth authorization flow.
   * Exchanges authorization code for tokens, resolves user identity, and stores credential.
   *
   * @param state - State parameter from OAuth callback
   * @param code - Authorization code from OAuth callback
   * @returns OAuth credential and optional redirect URI
   * @throws {OAuthServiceError} If flow not found, expired, or token exchange fails
   *
   * @example
   * ```ts
   * const { credential, redirectUri } = await service.completeFlow(state, code);
   * console.log(`Authenticated as ${credential.userIdentifier}`);
   * if (redirectUri) {
   *   // redirect user back to their app
   * }
   * ```
   */
  /**
   * Complete a delegated OAuth flow.
   *
   * Tokens were already exchanged by the external delegated endpoint
   * and arrive in the callback's query params. No code exchange runs
   * here; we parse, validate the CSRF (which is the JWT state itself,
   * echoed back), and persist.
   */
  async completeDelegatedFlow(
    state: string,
    rawQuery: Record<string, string>,
  ): Promise<{ credential: OAuthCredential; redirectUri?: string }> {
    let decoded: StatePayload;
    try {
      decoded = await decodeState(state);
    } catch {
      throw new OAuthServiceError("FLOW_NOT_FOUND", "OAuth flow not found or expired");
    }

    const { p: providerId, r: redirectUri, u: userId } = decoded;

    const provider = await this.registry.get(providerId);
    if (!provider) {
      throw new OAuthServiceError("PROVIDER_NOT_FOUND", `Provider '${providerId}' not found`);
    }
    if (provider.type !== "oauth") {
      throw new OAuthServiceError(
        "INVALID_PROVIDER_TYPE",
        `Provider '${providerId}' is not an OAuth provider`,
      );
    }
    if (provider.oauthConfig.mode !== "delegated") {
      throw new OAuthServiceError(
        "INVALID_MODE",
        `Provider '${providerId}' is not configured for delegated mode`,
      );
    }

    const tokens = parseDelegatedCallback(rawQuery, state);

    const userIdentifier = await this.resolveUserIdentity(
      {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_at: tokens.expires_at,
        scope: tokens.scope,
      },
      // authServer is unused by resolveUserIdentity; pass an empty stub
      { issuer: "" } as oauth.AuthorizationServer,
      provider,
      provider.oauthConfig.clientId,
    );

    const credentialInput = {
      type: "oauth" as const,
      provider: providerId,
      userIdentifier,
      label: userIdentifier,
      secret: {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        token_type: tokens.token_type,
        expires_at: tokens.expires_at,
        granted_scopes: tokens.scope ? tokens.scope.split(" ") : undefined,
        client_id: provider.oauthConfig.clientId,
      },
    };

    const { id, isDefault, metadata } = await this.storage.upsert(credentialInput, userId || "dev");

    const credential: OAuthCredential = {
      id,
      type: "oauth",
      provider: providerId,
      userIdentifier,
      label: userIdentifier,
      isDefault,
      secret: credentialInput.secret,
      metadata,
    };

    return { credential, redirectUri };
  }

  async completeFlow(
    state: string,
    code: string,
  ): Promise<{ credential: OAuthCredential; redirectUri?: string }> {
    // 1. Decode and verify JWT state
    let decoded: StatePayload;
    try {
      decoded = await decodeState(state);
    } catch {
      throw new OAuthServiceError("FLOW_NOT_FOUND", "OAuth flow not found or expired");
    }

    const {
      v: codeVerifier,
      p: providerId,
      c: callbackUrl,
      r: redirectUri,
      u: userId,
      i: clientId,
    } = decoded;

    // 2. Get provider from registry
    const provider = await this.registry.get(providerId);
    if (!provider) {
      throw new OAuthServiceError("PROVIDER_NOT_FOUND", `Provider '${providerId}' not found`);
    }
    if (provider.type !== "oauth") {
      throw new OAuthServiceError(
        "INVALID_PROVIDER_TYPE",
        `Provider '${providerId}' is not an OAuth provider`,
      );
    }

    // 3. Rebuild authServer and clientReg based on config mode
    const config = provider.oauthConfig;
    let authServer: oauth.AuthorizationServer;
    let clientReg: ClientRegistration;
    let clientAuth: oauth.ClientAuth;

    if (config.mode === "static") {
      // Static mode: rebuild from config
      authServer = buildStaticAuthServer(config);
      clientReg = { client_id: config.clientId, redirect_uris: [callbackUrl] };
      clientAuth = getStaticClientAuth(config);
    } else if (config.mode === "discovery") {
      // Discovery mode: fresh discovery (discovery failure mid-flow orphans the flow - acceptable)
      authServer = await discoverAuthorizationServer(config.serverUrl);
      // Use client_id from state (was stored during initiateFlow)
      if (!clientId) {
        throw new OAuthServiceError(
          "NO_CLIENT_ID",
          "Flow state missing client_id - flow may have been initiated with older version",
        );
      }
      clientReg = { client_id: clientId, redirect_uris: [callbackUrl] };
      clientAuth = oauth.None();
    } else {
      // Delegated mode is handled by completeDelegatedFlow — callback.ts
      // routes to that method instead. Reaching here means a delegated
      // provider somehow landed in the standard flow.
      throw new OAuthServiceError(
        "INVALID_MODE",
        `Provider '${providerId}' is delegated mode; use completeDelegatedFlow`,
      );
    }

    // 4. Build callback params and validate
    const callbackParams = new URLSearchParams({ code, state });
    const client: oauth.Client = { client_id: clientReg.client_id };

    // Validate the authorization response (required by oauth4webapi v3)
    const validatedParams = oauth.validateAuthResponse(authServer, client, callbackParams, state);

    // 5. Exchange code for tokens
    const tokens = await exchangeAuthorizationCode(
      authServer,
      clientReg,
      validatedParams,
      callbackUrl, // must match what was used in auth URL
      codeVerifier,
      clientAuth,
    );

    // 6. Resolve user identity
    const userIdentifier = await this.resolveUserIdentity(
      tokens,
      authServer,
      provider,
      clientReg.client_id,
    );

    // 7. Build credential input (id generated by storage)
    const credentialInput = {
      type: "oauth" as const,
      provider: providerId,
      userIdentifier,
      label: userIdentifier,
      secret: {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        token_type: "Bearer",
        expires_at: tokens.expires_at,
        granted_scopes: tokens.scope ? tokens.scope.split(" ") : undefined,
        client_id: clientReg.client_id,
      },
    };

    // 8. Upsert credential (atomic create-or-update by provider+label identity)
    const { id, isDefault, metadata } = await this.storage.upsert(credentialInput, userId || "dev");

    // Build OAuthCredential response (includes userIdentifier)
    const credential: OAuthCredential = {
      id,
      type: "oauth",
      provider: providerId,
      userIdentifier,
      label: userIdentifier,
      isDefault,
      secret: credentialInput.secret,
      metadata,
    };

    // 9. Return credential and optional redirectUri
    return { credential, redirectUri };
  }

  /**
   * Resolve user identity from tokens using provider's identify method.
   * Falls back to token prefix if identification fails to avoid blocking auth.
   *
   * @param tokens - Token exchange result
   * @param _authServer - Authorization server metadata (unused)
   * @param provider - OAuth provider
   * @param _clientId - OAuth client ID (unused)
   * @returns User identifier from provider.identify(), or fallback on failure
   */
  private async resolveUserIdentity(
    tokens: TokenExchangeResult,
    _authServer: oauth.AuthorizationServer,
    provider: OAuthProvider,
    _clientId: string,
  ): Promise<string> {
    try {
      return await provider.identify({
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        token_type: "Bearer",
        expires_at: tokens.expires_at,
      });
    } catch (error) {
      // Fallback: use token prefix to avoid blocking auth entirely
      // MCP tools can change without warning (see: Notion notion-get-self deprecation)
      logger.error("oauth_identify_fallback", { provider: provider.id, error });
      return `${provider.id}:${tokens.access_token.slice(0, 8)}...`;
    }
  }

  /**
   * Refresh a credential's tokens using its refresh token.
   *
   * @param credential - OAuth credential to refresh
   * @param userId - User ID for multi-tenant credential storage
   * @returns Updated OAuth credential with new tokens
   * @throws {OAuthServiceError} If provider not found, no refresh token, or refresh fails
   *
   * @example
   * ```ts
   * const updated = await service.refreshCredential(credential, "user-123");
   * console.log(`New access token expires at ${updated.secret.expires_at}`);
   * ```
   */
  refreshCredential(credential: OAuthCredential, userId: string): Promise<OAuthCredential> {
    // Check for in-flight refresh - if one exists, wait for it instead of starting another
    const existing = this.refreshLocks.get(credential.id);
    if (existing) {
      return existing;
    }

    // Start refresh and track it in the lock map
    const refreshPromise = this.doRefresh(credential, userId).finally(() => {
      this.refreshLocks.delete(credential.id);
    });

    this.refreshLocks.set(credential.id, refreshPromise);
    return refreshPromise;
  }

  /**
   * Internal method that performs the actual token refresh.
   * Called by refreshCredential after acquiring the mutex.
   */
  private async doRefresh(credential: OAuthCredential, userId: string): Promise<OAuthCredential> {
    // 1. Get provider, verify OAuth type
    const provider = await this.registry.get(credential.provider);
    if (!provider) {
      throw new OAuthServiceError(
        "PROVIDER_NOT_FOUND",
        `Provider '${credential.provider}' not found`,
      );
    }
    if (provider.type !== "oauth") {
      throw new OAuthServiceError(
        "INVALID_PROVIDER_TYPE",
        `Provider '${credential.provider}' is not an OAuth provider`,
      );
    }

    // Check for refresh token
    if (!credential.secret.refresh_token) {
      throw new OAuthServiceError(
        "NO_REFRESH_TOKEN",
        `Credential '${credential.id}' has no refresh token`,
      );
    }

    const config = provider.oauthConfig;

    // Delegated mode: refresh via the external endpoint, then short-circuit.
    if (config.mode === "delegated") {
      const refreshed = await refreshDelegatedToken(config, credential.secret.refresh_token);
      const updatedSecret = {
        access_token: refreshed.access_token,
        // Upstream never returns a fresh refresh_token; preserve the original.
        refresh_token: refreshed.refresh_token,
        token_type: refreshed.token_type,
        expires_at: refreshed.expires_at,
        granted_scopes: refreshed.scope
          ? refreshed.scope.split(" ")
          : credential.secret.granted_scopes,
        client_id: credential.secret.client_id,
      };
      const credentialInput = {
        type: "oauth" as const,
        provider: credential.provider,
        userIdentifier: credential.userIdentifier,
        label: credential.label,
        secret: updatedSecret,
      };
      const metadata = await this.storage.update(credential.id, credentialInput, userId);
      return { ...credential, secret: updatedSecret, metadata };
    }

    // 2. Build authServer, clientAuth, and clientReg based on config mode
    let authServer: oauth.AuthorizationServer;
    let clientAuth: oauth.ClientAuth;
    let clientReg: ClientRegistration;

    if (config.mode === "static") {
      // Static mode: build from config
      authServer = buildStaticAuthServer(config);
      clientAuth = getStaticClientAuth(config);
      clientReg = { client_id: config.clientId, redirect_uris: [] };
    } else {
      // Discovery mode: fresh discovery on each refresh
      authServer = await discoverAuthorizationServer(config.serverUrl);

      // Use stored client_id from credential
      const clientId = credential.secret.client_id;
      if (!clientId) {
        throw new OAuthServiceError(
          "NO_CLIENT_ID",
          "Credential missing client_id - re-authenticate",
        );
      }
      clientReg = { client_id: clientId, redirect_uris: [] };
      clientAuth = oauth.None();
    }

    // 3. Call refreshAccessToken with clientAuth
    const tokens = await refreshAccessToken(
      authServer,
      clientReg,
      credential.secret.refresh_token,
      clientAuth,
    );

    // 4. Build updated credential input
    const updatedSecret = {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token, // may be rotated
      token_type: "Bearer",
      expires_at: tokens.expires_at,
      granted_scopes: tokens.scope ? tokens.scope.split(" ") : credential.secret.granted_scopes,
      client_id: credential.secret.client_id,
    };

    const credentialInput = {
      type: "oauth" as const,
      provider: credential.provider,
      userIdentifier: credential.userIdentifier,
      label: credential.label,
      secret: updatedSecret,
    };

    // 5. Update and return credential with storage-set timestamp
    const metadata = await this.storage.update(credential.id, credentialInput, userId);

    return { ...credential, secret: updatedSecret, metadata };
  }
}
