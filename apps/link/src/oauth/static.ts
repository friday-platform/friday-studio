/**
 * Static OAuth helper functions for providers with pre-configured endpoints.
 * These helpers build oauth4webapi structures from static mode OAuthConfig.
 *
 * @module oauth/static
 */

import type { OAuthConfig } from "../providers/types.ts";
import * as oauth from "./client.ts";

/**
 * Build an AuthorizationServer object from static mode OAuth config.
 * Creates the minimal structure needed for oauth4webapi token operations.
 *
 * @param config - Static mode OAuth configuration with explicit endpoints
 * @returns AuthorizationServer object for use with oauth4webapi functions
 */
export function buildStaticAuthServer(
  config: Extract<OAuthConfig, { mode: "static" }>,
): oauth.AuthorizationServer {
  return {
    issuer: new URL(config.authorizationEndpoint).origin,
    authorization_endpoint: config.authorizationEndpoint,
    token_endpoint: config.tokenEndpoint,
    userinfo_endpoint: config.userinfoEndpoint,
    revocation_endpoint: config.revocationEndpoint,
  };
}

/**
 * Client auth that sends client_id with an empty client_secret.
 * Google Desktop app OAuth clients may require the client_secret parameter
 * to be present even though PKCE provides the security. Sending an empty
 * string satisfies Google's form validation without shipping a real secret.
 */
function EmptyClientSecretPost(clientId: string): oauth.ClientAuth {
  return (_as, client, body, _headers) => {
    body.set("client_id", client.client_id || clientId);
    body.set("client_secret", "");
  };
}

/**
 * Get the appropriate client authentication method for token requests.
 * Maps static config clientAuthMethod to oauth4webapi ClientAuth.
 *
 * @param config - Static mode OAuth configuration with clientSecret and clientAuthMethod
 * @returns ClientAuth function for use in token endpoint requests
 */
export function getStaticClientAuth(
  config: Extract<OAuthConfig, { mode: "static" }>,
): oauth.ClientAuth {
  if (config.clientAuthMethod === "none") {
    // Google Desktop app clients may require client_secret to be present
    // even though PKCE provides the actual security. Send empty string.
    return EmptyClientSecretPost(config.clientId);
  }
  if (!config.clientSecret) {
    return oauth.None();
  }
  return config.clientAuthMethod === "client_secret_basic"
    ? oauth.ClientSecretBasic(config.clientSecret)
    : oauth.ClientSecretPost(config.clientSecret);
}
