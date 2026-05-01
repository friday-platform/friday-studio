/**
 * OAuth Authorization Server Discovery
 * Implements RFC 9728 (Protected Resource Metadata) with fallback to RFC 8414 (AS Metadata)
 *
 * Discovery order:
 * 1. Try RFC 9728: /.well-known/oauth-protected-resource → extract issuer → fetch AS metadata
 * 2. Fallback to RFC 8414: /.well-known/oauth-authorization-server directly on serverUrl
 *
 * This fallback is necessary because many OAuth providers (e.g., Linear) only implement
 * RFC 8414 and don't expose Protected Resource Metadata.
 *
 * @module oauth/discovery
 */

import { deadline } from "@std/async/deadline";
import { z } from "zod";
import * as oauth from "./client.ts";
import { shouldAllowInsecureForLocalDev } from "./utils.ts";

const DISCOVERY_TIMEOUT_MS = 10_000;

/**
 * Protected Resource Metadata schema (RFC 9728)
 * https://datatracker.ietf.org/doc/html/rfc9728
 */
const ProtectedResourceMetadataSchema = z.object({
  resource: z.url().optional(),
  authorization_servers: z.array(z.url()).min(1),
  bearer_methods_supported: z.array(z.string()).optional(),
  resource_signing_alg_values_supported: z.array(z.string()).optional(),
  resource_encryption_alg_values_supported: z.array(z.string()).optional(),
  resource_encryption_enc_values_supported: z.array(z.string()).optional(),
});

/**
 * Attempt RFC 9728 Protected Resource Metadata discovery
 *
 * @param serverUrl - The server URL to discover from
 * @returns The issuer URL if successful, null if RFC 9728 is not supported
 */
async function tryProtectedResourceDiscovery(serverUrl: string): Promise<URL | null> {
  const prUrl = new URL("/.well-known/oauth-protected-resource", serverUrl);

  let prResponse: Response;
  try {
    prResponse = await deadline(fetch(prUrl), DISCOVERY_TIMEOUT_MS);
  } catch {
    return null;
  }

  if (!prResponse.ok) {
    return null;
  }

  try {
    const json: unknown = await prResponse.json();
    const protectedResource = ProtectedResourceMetadataSchema.parse(json);
    const issuerUrl = protectedResource.authorization_servers.at(0);
    return issuerUrl ? new URL(issuerUrl) : null;
  } catch {
    return null;
  }
}

/**
 * Schema for OAuth AS Metadata (RFC 8414) with required fields for our use case.
 * We only validate the fields we need; additional fields are passed through.
 */
const ASMetadataSchema = z
  .object({
    issuer: z.url(),
    authorization_endpoint: z.string().optional(),
    token_endpoint: z.string().optional(),
    registration_endpoint: z.string().optional(),
    revocation_endpoint: z.string().optional(),
  })
  .passthrough();

/**
 * Discover Authorization Server metadata from an issuer URL
 *
 * Uses oauth4webapi which tries /.well-known/oauth-authorization-server first,
 * then falls back to /.well-known/openid-configuration
 *
 * @param issuer - The issuer URL
 * @returns Authorization Server metadata
 */
async function discoverFromIssuer(issuer: URL): Promise<oauth.AuthorizationServer> {
  const asResponse = await deadline(
    oauth.discoveryRequest(issuer, {
      algorithm: "oauth2",
      [oauth.allowInsecureRequests]: shouldAllowInsecureForLocalDev(),
    }),
    DISCOVERY_TIMEOUT_MS,
  );

  return oauth.processDiscoveryResponse(issuer, asResponse);
}

/**
 * Fetch OAuth AS metadata from a URL and handle issuer mismatch.
 *
 * Some providers (e.g., Atlassian) serve discovery metadata at one origin but
 * report a different issuer in the metadata itself. Per RFC 8414 Section 3.3,
 * the `issuer` in the response is authoritative. This function:
 * 1. Fetches metadata from the discovery URL
 * 2. Extracts the actual issuer from the response
 * 3. Re-validates using the correct issuer for proper signature/claim verification
 *
 * @param discoveryOrigin - The origin URL to fetch discovery metadata from
 * @returns Authorization Server metadata with validated issuer
 */
async function discoverFromOriginWithIssuerRedirect(
  discoveryOrigin: URL,
): Promise<oauth.AuthorizationServer> {
  // Fetch the raw metadata to extract the actual issuer
  const wellKnownUrl = new URL("/.well-known/oauth-authorization-server", discoveryOrigin);

  const rawResponse = await deadline(
    fetch(wellKnownUrl, { headers: { Accept: "application/json" } }),
    DISCOVERY_TIMEOUT_MS,
  );

  if (!rawResponse.ok) {
    throw new Error(`Discovery request failed: ${rawResponse.status}`);
  }

  const rawMetadata = ASMetadataSchema.parse(await rawResponse.json());
  const actualIssuer = new URL(rawMetadata.issuer);

  // If the issuer matches the discovery origin, use standard flow
  if (actualIssuer.origin === discoveryOrigin.origin) {
    return discoverFromIssuer(discoveryOrigin);
  }

  // Issuer differs from discovery origin - re-discover from actual issuer
  // This handles cases like Atlassian where discovery is at mcp.atlassian.com
  // but issuer is cf.mcp.atlassian.com
  return discoverFromIssuer(actualIssuer);
}

/**
 * Discover OAuth Authorization Server for a protected resource
 *
 * Implements a two-phase discovery with fallback:
 *
 * **Phase 1 - RFC 9728 (Protected Resource Metadata):**
 * 1. Fetch {serverUrl}/.well-known/oauth-protected-resource
 * 2. Extract authorization_servers[0] as the issuer URL
 * 3. Discover AS metadata from the issuer
 *
 * **Phase 2 - RFC 8414 Fallback (if Phase 1 fails):**
 * 1. Treat serverUrl itself as the issuer
 * 2. Discover AS metadata directly from serverUrl
 *
 * This fallback is necessary because providers like Linear only implement RFC 8414.
 *
 * @param serverUrl - The MCP server URL (e.g., https://mcp.example.com)
 * @returns Authorization Server metadata
 * @throws Error if both discovery methods fail
 *
 * @example
 * ```ts
 * const authServer = await discoverAuthorizationServer('https://mcp.example.com')
 * console.log(authServer.authorization_endpoint)
 * ```
 */
export async function discoverAuthorizationServer(
  serverUrl: string,
): Promise<oauth.AuthorizationServer> {
  // Phase 1: Try RFC 9728 Protected Resource Metadata
  const issuerFromPRM = await tryProtectedResourceDiscovery(serverUrl);
  if (issuerFromPRM) {
    return discoverFromIssuer(issuerFromPRM);
  }

  // Phase 2: RFC 8414 fallback - try origin first, then with path
  // Most providers (e.g., Linear) have issuer at origin even when MCP endpoint has a path
  const serverUrlObj = new URL(serverUrl);
  const hasPath = serverUrlObj.pathname !== "/" && serverUrlObj.pathname !== "";

  // Try origin-only first (most common case)
  // Use discoverFromOriginWithIssuerRedirect to handle providers like Atlassian
  // that serve discovery from one origin but report a different issuer
  try {
    return await discoverFromOriginWithIssuerRedirect(new URL(serverUrlObj.origin));
  } catch (originError) {
    if (!hasPath) {
      throw new Error(`OAuth discovery failed for ${serverUrl}`, { cause: originError });
    }

    // Try with path appended (per RFC 8414 spec for path-based issuers)
    try {
      return await discoverFromIssuer(serverUrlObj);
    } catch (pathError) {
      throw new Error(`OAuth discovery failed for ${serverUrl}`, { cause: pathError });
    }
  }
}
