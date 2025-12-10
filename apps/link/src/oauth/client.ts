/**
 * OAuth 4 Web API wrapper
 * Thin re-export layer for oauth4webapi functions used by Link
 *
 * @module oauth/client
 */

// Type exports
export type {
  AuthorizationResponseError,
  AuthorizationServer,
  Client,
  ClientAuth,
  OAuth2Error,
  ResponseBodyError,
  TokenEndpointResponse,
  WWWAuthenticateChallengeError,
} from "oauth4webapi";
export {
  allowInsecureRequests,
  authorizationCodeGrantRequest,
  ClientSecretBasic,
  ClientSecretPost,
  calculatePKCECodeChallenge,
  discoveryRequest,
  dynamicClientRegistrationRequest,
  generateRandomCodeVerifier,
  None,
  processAuthorizationCodeResponse,
  processDiscoveryResponse,
  processDynamicClientRegistrationResponse,
  processRefreshTokenResponse,
  processRevocationResponse,
  refreshTokenGrantRequest,
  revocationRequest,
  validateAuthResponse,
} from "oauth4webapi";
