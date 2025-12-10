/**
 * OAuth Authorization Server Discovery
 * Implements RFC 9728 (Protected Resource Metadata) + RFC 8414 (AS Metadata)
 *
 * @module oauth/discovery
 */

import { logger } from "@atlas/logger";
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

type ProtectedResourceMetadata = z.infer<typeof ProtectedResourceMetadataSchema>;

/**
 * Discover OAuth Authorization Server for a protected resource
 *
 * Implements the two-phase discovery chain required for MCP servers:
 * 1. Fetch Protected Resource Metadata from {serverUrl}/.well-known/oauth-protected-resource (RFC 9728)
 * 2. Extract authorization_servers[0] as the issuer URL
 * 3. Use oauth4webapi to discover AS metadata from the issuer (RFC 8414)
 *
 * @param serverUrl - The MCP server URL (e.g., https://mcp.example.com)
 * @returns Authorization Server metadata
 * @throws Error if discovery fails at any step
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
  // Step 1: Fetch Protected Resource Metadata (RFC 9728)
  const prUrl = new URL("/.well-known/oauth-protected-resource", serverUrl);
  const prResponse = await deadline(fetch(prUrl), DISCOVERY_TIMEOUT_MS);

  if (!prResponse.ok) {
    throw new Error(
      `Failed to fetch protected resource metadata from ${prUrl}: ${prResponse.status} ${prResponse.statusText}`,
    );
  }

  let protectedResource: ProtectedResourceMetadata;
  try {
    const json = await prResponse.json();
    protectedResource = ProtectedResourceMetadataSchema.parse(json);
  } catch (error) {
    logger.error("Invalid Protected Resource Metadata", { serverUrl, error });
    throw new Error(`Invalid Protected Resource Metadata from ${prUrl}`);
  }

  // Step 2: Extract issuer URL
  const issuerUrl = protectedResource.authorization_servers.at(0);
  if (!issuerUrl) {
    throw new Error(`No authorization server found in protected resource metadata from ${prUrl}`);
  }

  // Step 3: Discover AS metadata via oauth4webapi (RFC 8414)
  const issuer = new URL(issuerUrl);
  const asResponse = await deadline(
    oauth.discoveryRequest(issuer, {
      // tries .well-known/oauth-authorization-server first, then /.well-known/openid-configuration
      algorithm: "oauth2",
      [oauth.allowInsecureRequests]: shouldAllowInsecureForLocalDev(),
    }),
    DISCOVERY_TIMEOUT_MS,
  );

  return oauth.processDiscoveryResponse(issuer, asResponse);
}
