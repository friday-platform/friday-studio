/**
 * App Install Routes
 * Browser-facing OAuth flow endpoints for app installations (Slack, GitHub, Discord)
 */

import type { Context } from "hono";
import { z } from "zod";
import { AppInstallError } from "../app-install/errors.ts";
import type { AppInstallService } from "../app-install/service.ts";
import { factory } from "../factory.ts";
import { renderErrorResponse, renderSuccessResponse } from "../oauth/responses.ts";

const AuthorizeQuerySchema = z.object({
  redirect_uri: z.string().optional(),
  user_id: z.string().optional(),
});

const CallbackQuerySchema = z.object({
  state: z.string().min(1),
  code: z.string().optional(),
  error: z.string().optional(),
  error_description: z.string().optional(),
});

const ReconcileBodySchema = z.object({ credential_id: z.string().min(1) });

/**
 * Create app install router with authorize, callback, and reconcile endpoints.
 * Mounted at /v1/app-install in main app.
 *
 * Routes:
 * - GET /:provider/authorize - Initiate OAuth app install flow
 * - GET /callback - OAuth callback (shared across providers)
 * - POST /:provider/reconcile - Re-upsert route for existing credential
 *
 * @param service - App install service for flow management
 * @returns Hono router with app install endpoints
 */
export function createAppInstallRoutes(service: AppInstallService) {
  return (
    factory
      .createApp()
      /**
       * GET /v1/app-install/:provider/authorize
       * Initiate app installation flow - redirects to provider's authorization endpoint
       */
      .get("/:provider/authorize", async (c) => {
        const provider = c.req.param("provider");

        // Parse and validate query params
        const query = AuthorizeQuerySchema.safeParse(c.req.query());
        if (!query.success) {
          return c.json({ error: "invalid_query", message: query.error.message }, 400);
        }

        const { redirect_uri, user_id } = query.data;

        // Validate redirect_uri format if provided
        if (redirect_uri) {
          try {
            new URL(redirect_uri);
          } catch {
            return c.json({ error: "invalid_redirect_uri" }, 400);
          }
        }

        try {
          const { authorizationUrl } = await service.initiateInstall(
            provider,
            redirect_uri,
            user_id,
          );

          return c.redirect(authorizationUrl, 302);
        } catch (e) {
          if (e instanceof AppInstallError) {
            return mapAppInstallErrorToResponse(c, e);
          }
          const message = e instanceof Error ? e.message : "Unknown error";
          return c.json({ error: "app_install_failed", message }, 500);
        }
      })
      /**
       * GET /v1/app-install/callback
       * OAuth callback - exchange code for tokens, create credential, upsert route
       */
      .get("/callback", async (c) => {
        // Parse and validate query params
        const query = CallbackQuerySchema.safeParse(c.req.query());
        if (!query.success) {
          return c.json({ error: "invalid_query", message: query.error.message }, 400);
        }

        const { state, code, error, error_description } = query.data;

        // Provider returned an error (user denied or provider error)
        if (error) {
          return renderErrorResponse(c, error, error_description);
        }

        // Must have code to complete flow
        if (!code) {
          return renderErrorResponse(c, "missing_code", "No authorization code in callback");
        }

        try {
          const { credential, redirectUri } = await service.completeInstall(state, code);

          // Redirect back to caller's app if they provided redirect_uri
          if (redirectUri) {
            const url = new URL(redirectUri);
            url.searchParams.set("credential_id", credential.id);
            url.searchParams.set("provider", credential.provider);
            return c.redirect(url.toString(), 302);
          }

          // No redirect_uri - render success page
          return renderSuccessResponse(c, credential.provider, credential.id);
        } catch (e) {
          if (e instanceof AppInstallError) {
            return mapAppInstallErrorToResponse(c, e);
          }
          const message = e instanceof Error ? e.message : "Unknown error";
          return c.json({ error: "app_install_completion_failed", message }, 500);
        }
      })
      /**
       * POST /v1/app-install/:provider/reconcile
       * Re-upsert platform route for existing credential (recovery endpoint)
       */
      .post("/:provider/reconcile", async (c) => {
        const provider = c.req.param("provider");

        // Parse and validate body
        const body = ReconcileBodySchema.safeParse(await c.req.json().catch(() => ({})));
        if (!body.success) {
          return c.json({ error: "invalid_body", message: body.error.message }, 400);
        }

        const userId = c.get("userId");
        const { credential_id } = body.data;

        try {
          await service.reconcileRoute(provider, credential_id, userId);
          return c.json({ status: "ok", message: "Route reconciled" }, 200);
        } catch (e) {
          if (e instanceof AppInstallError) {
            return mapAppInstallErrorToResponse(c, e);
          }
          const message = e instanceof Error ? e.message : "Unknown error";
          return c.json({ error: "reconcile_failed", message }, 500);
        }
      })
  );
}

/**
 * Map AppInstallError codes to appropriate HTTP responses.
 */
function mapAppInstallErrorToResponse(c: Context, e: AppInstallError) {
  switch (e.code) {
    case "STATE_INVALID":
      return c.json({ error: e.code, message: e.message }, 400);
    case "PROVIDER_NOT_FOUND":
      return c.json({ error: e.code, message: e.message }, 404);
    case "INVALID_PROVIDER_TYPE":
      return c.json({ error: e.code, message: e.message }, 400);
    case "SLACK_NETWORK_ERROR":
    case "SLACK_HTTP_ERROR":
    case "SLACK_PARSE_ERROR":
    case "SLACK_OAUTH_ERROR":
      return c.json({ error: e.code, message: e.message }, 502);
    case "CREDENTIAL_NOT_FOUND":
    case "INVALID_CREDENTIAL":
      return c.json({ error: e.code, message: e.message }, 500);
    default:
      return c.json({ error: "unknown_error", message: e.message }, 500);
  }
}
