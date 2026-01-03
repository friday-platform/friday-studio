/**
 * OAuth Routes
 * Browser-facing OAuth flow endpoints
 *
 * Note: Callback is handled by unified /v1/callback/:provider route
 */

import { env } from "node:process";
import { logger } from "@atlas/logger";
import { z } from "zod";
import { factory } from "../factory.ts";
import type { OAuthService } from "../oauth/service.ts";
import type { ProviderRegistry } from "../providers/registry.ts";
import type { OAuthCredential, StorageAdapter } from "../types.ts";

const AuthorizeQuerySchema = z.object({
  redirect_uri: z.string().optional(),
  scopes: z.string().optional(), // comma-separated
});

/**
 * Create OAuth router with authorization and refresh endpoints.
 * Mounted at /v1/oauth in main app.
 * Callback is handled separately at /v1/callback/:provider.
 *
 * @param registry - Provider registry for validation
 * @param oauthService - OAuth service for flow management
 * @param storage - Storage adapter for credential access
 * @returns Hono router with OAuth endpoints
 */
export function createOAuthRoutes(
  registry: ProviderRegistry,
  oauthService: OAuthService,
  storage: StorageAdapter,
) {
  return (
    factory
      .createApp()
      /**
       * GET /authorize/:provider
       * Initiate OAuth flow - redirects to provider's authorization endpoint
       */
      .get("/authorize/:provider", async (c) => {
        const userId = c.get("userId");
        const providerId = c.req.param("provider");

        // Validate provider exists and is OAuth type
        const provider = registry.get(providerId);
        if (!provider) {
          return c.json({ error: "provider_not_found" }, 404);
        }
        if (provider.type !== "oauth") {
          return c.json(
            { error: "provider_not_oauth", message: "Provider does not support OAuth" },
            400,
          );
        }

        // Parse query params
        const query = AuthorizeQuerySchema.safeParse(c.req.query());
        if (!query.success) {
          return c.json({ error: "invalid_query", message: query.error.message }, 400);
        }

        const { redirect_uri, scopes } = query.data;

        // Validate redirect_uri format if provided
        if (redirect_uri) {
          try {
            new URL(redirect_uri);
          } catch {
            return c.json({ error: "invalid_redirect_uri" }, 400);
          }
        }

        // Build callback URL for this service (provider-namespaced for readability)
        const baseUrl = env.LINK_CALLBACK_BASE || c.get("externalBaseUrl");
        const callbackUrl = `${baseUrl}/v1/callback/${providerId}`;

        try {
          const { authorizationUrl } = await oauthService.initiateFlow(
            providerId,
            callbackUrl,
            redirect_uri,
            scopes?.split(","),
            userId,
          );

          return c.redirect(authorizationUrl, 302);
        } catch (e) {
          logger.error("OAuth initiation failed", { provider: providerId, error: e });
          return c.json(
            { error: "oauth_initiation_failed", message: "Failed to initiate OAuth flow" },
            502,
          );
        }
      })
      /**
       * POST /credentials/:id/refresh
       * Manually refresh OAuth credential tokens
       */
      .post("/credentials/:id/refresh", async (c) => {
        const userId = c.get("userId");
        const id = c.req.param("id");

        const credential = await storage.get(id, userId);
        if (!credential) {
          return c.json({ error: "credential_not_found" }, 404);
        }

        if (credential.type !== "oauth") {
          return c.json(
            { error: "refresh_not_supported", message: "Only OAuth credentials support refresh" },
            400,
          );
        }

        if (!credential.secret?.refresh_token) {
          return c.json(
            { error: "no_refresh_token", message: "Credential has no refresh token" },
            400,
          );
        }

        try {
          const refreshed = await oauthService.refreshCredential(
            credential as OAuthCredential,
            userId,
          );
          return c.json({
            refreshed: true,
            expiresAt: refreshed.secret.expires_at
              ? new Date(refreshed.secret.expires_at * 1000).toISOString()
              : null,
          });
        } catch (e) {
          logger.error("OAuth token refresh failed", { credentialId: id, error: e });
          return c.json({ error: "refresh_failed", message: "Failed to refresh token" }, 502);
        }
      })
  );
}
