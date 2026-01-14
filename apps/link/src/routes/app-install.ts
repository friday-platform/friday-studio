/**
 * App Install Routes
 * Browser-facing OAuth flow endpoints for app installations (Slack, GitHub, Discord)
 *
 * Note: Callback is handled by unified /v1/callback/:provider route
 */

import { zValidator } from "@hono/zod-validator";
import type { Context } from "hono";
import { z } from "zod";
import { AppInstallError } from "../app-install/errors.ts";
import type { AppInstallService } from "../app-install/service.ts";
import { factory } from "../factory.ts";

const AuthorizeQuerySchema = z.object({ redirect_uri: z.string().optional() });

const ReconcileBodySchema = z.object({ credential_id: z.string().min(1) });

/**
 * Create app install router with authorize and reconcile endpoints.
 * Mounted at /v1/app-install in main app.
 * Callback is handled separately at /v1/callback/:provider.
 *
 * Routes:
 * - GET /:provider/authorize - Initiate OAuth app install flow
 * - POST /:provider/reconcile - Re-upsert route for existing credential
 * - DELETE /:provider/:credentialId - Uninstall app (remove route and credential)
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

        const { redirect_uri } = query.data;
        const userId = c.get("userId"); // From JWT middleware, always present

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
            userId,
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
      /**
       * DELETE /v1/app-install/:provider/:credentialId
       * Uninstall app - removes route and credential
       */
      .delete(
        "/:provider/:credentialId",
        zValidator("param", z.object({ provider: z.string(), credentialId: z.string() })),
        async (c) => {
          const userId = c.get("userId");
          const { provider, credentialId } = c.req.valid("param");

          try {
            await service.uninstall(provider, credentialId, userId);
            return c.body(null, 204);
          } catch (error) {
            if (error instanceof AppInstallError) {
              return mapAppInstallErrorToResponse(c, error);
            }
            return c.json({ error: "Failed to uninstall" }, 500);
          }
        },
      )
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
