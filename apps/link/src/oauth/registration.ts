/**
 * OAuth Dynamic Client Registration
 * Uses oauth4webapi for RFC 7591 implementation
 *
 * @module oauth/registration
 */

import type { AuthorizationServer, Client, ResponseBodyError } from "./client.ts";
import * as oauth from "./client.ts";
import { shouldAllowInsecureForLocalDev } from "./utils.ts";

/**
 * OAuth error thrown during client registration
 */
class OAuthRegistrationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "OAuthRegistrationError";
  }
}

/**
 * Register a public OAuth client with an authorization server using dynamic client registration (RFC 7591)
 *
 * @param authServer - Authorization server metadata (must include registration_endpoint)
 * @param callbackUrl - Redirect URI for the client (where auth codes will be sent)
 * @returns Client registration containing client_id and optional client_secret
 * @throws {OAuthRegistrationError} If registration endpoint missing or registration fails
 *
 * @example
 * ```ts
 * const authServer = await discoverAuthorizationServer("https://example.com");
 * const registration = await registerClient(authServer, "http://localhost:3000/callback");
 * console.log(registration.client_id);
 * ```
 */
export async function registerClient(
  authServer: AuthorizationServer,
  callbackUrl: string,
): Promise<Client> {
  if (!authServer.registration_endpoint) {
    throw new OAuthRegistrationError(
      "REGISTRATION_FAILED",
      "Authorization server does not support dynamic client registration",
    );
  }

  try {
    const response = await oauth.dynamicClientRegistrationRequest(
      authServer,
      {
        redirect_uris: [callbackUrl],
        client_name: "Friday",
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      },
      { [oauth.allowInsecureRequests]: shouldAllowInsecureForLocalDev() },
    );

    return await oauth.processDynamicClientRegistrationResponse(response);
  } catch (error) {
    if (error instanceof Error && error.constructor.name === "ResponseBodyError") {
      const rbError = error as ResponseBodyError;
      throw new OAuthRegistrationError("REGISTRATION_FAILED", rbError.message, rbError.status);
    }
    throw error;
  }
}
