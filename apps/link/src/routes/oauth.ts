/**
 * OAuth Routes
 * Browser-facing OAuth flow endpoints
 */

import { z } from "zod";
import { factory } from "../factory.ts";
import { decodeState } from "../oauth/jwt-state.ts";
import { renderErrorResponse, renderSuccessResponse } from "../oauth/responses.ts";
import type { OAuthService } from "../oauth/service.ts";
import type { ProviderRegistry } from "../providers/registry.ts";
import type { OAuthCredential, StorageAdapter } from "../types.ts";

const AuthorizeQuerySchema = z.object({
  redirect_uri: z.string().optional(),
  scopes: z.string().optional(), // comma-separated
});

/**
 * Create OAuth router with authorization and callback endpoints.
 * Mounted at /v1/oauth in main app.
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

        // Build callback URL for this service
        const baseUrl = Deno.env.get("LINK_CALLBACK_BASE") || new URL(c.req.url).origin;
        const callbackUrl = `${baseUrl}/v1/oauth/callback`;

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
          const message = e instanceof Error ? e.message : "Unknown error";
          return c.json({ error: "oauth_initiation_failed", message }, 502);
        }
      })
      /**
       * GET /callback
       * OAuth callback - exchange code for tokens, create credential
       */
      .get("/callback", async (c) => {
        const { code, state, error, error_description } = c.req.query();

        // Must have state to look up flow
        if (!state) {
          return renderErrorResponse(c, "missing_state", "No state parameter in callback");
        }

        // Provider returned an error
        if (error) {
          // Try to decode state to see if we should redirect
          try {
            const decoded = await decodeState(state);
            if (decoded.r) {
              const url = new URL(decoded.r);
              url.searchParams.set("error", error);
              if (error_description) url.searchParams.set("error_description", error_description);
              return c.redirect(url.toString(), 302);
            }
          } catch {
            // Invalid/expired state, just render error
          }
          return renderErrorResponse(c, error, error_description);
        }

        // Must have code
        if (!code) {
          return renderErrorResponse(c, "missing_code", "No authorization code in callback");
        }

        try {
          const { credential, redirectUri } = await oauthService.completeFlow(state, code);

          if (redirectUri) {
            const url = new URL(redirectUri);
            url.searchParams.set("credential_id", credential.id);
            url.searchParams.set("provider", credential.provider);
            return c.redirect(url.toString(), 302);
          }

          return renderSuccessResponse(c, credential.provider, credential.id);
        } catch (e) {
          const message = e instanceof Error ? e.message : "Unknown error";
          return renderErrorResponse(c, "oauth_completion_failed", message);
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
          const message = e instanceof Error ? e.message : "Unknown error";
          return c.json({ error: "refresh_failed", message }, 502);
        }
      })
  );
}
