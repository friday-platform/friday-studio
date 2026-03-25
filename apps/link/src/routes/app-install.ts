/** Browser-facing OAuth flow endpoints for app installations. */

import { zValidator } from "@hono/zod-validator";
import type { Context } from "hono";
import { z } from "zod";
import { AppInstallError } from "../app-install/errors.ts";
import type { AppInstallService } from "../app-install/service.ts";
import { factory } from "../factory.ts";

const AuthorizeQuerySchema = z.object({
  redirect_uri: z.string().optional(),
  credential_id: z.string().optional(),
});

const ReconcileBodySchema = z.object({ credential_id: z.string().min(1) });

/** Authorize, reconcile, uninstall. Mounted at /v1/app-install. */
export function createAppInstallRoutes(service: AppInstallService) {
  return factory
    .createApp()
    .get("/:provider/authorize", async (c) => {
      const provider = c.req.param("provider");

      const query = AuthorizeQuerySchema.safeParse(c.req.query());
      if (!query.success) {
        return c.json({ error: "invalid_query", message: query.error.message }, 400);
      }

      const { redirect_uri, credential_id } = query.data;
      const userId = c.get("userId");

      if (redirect_uri) {
        try {
          new URL(redirect_uri);
        } catch {
          return c.json({ error: "invalid_redirect_uri" }, 400);
        }
      }

      try {
        // Try server-side reconnection first (e.g., GitHub App already installed)
        const credentials = await service.reconnect(provider, userId);
        if (credentials) {
          const credentialId = credentials[0]?.id;
          if (redirect_uri && credentialId) {
            const url = new URL(redirect_uri);
            url.searchParams.set("credential_id", credentialId);
            url.searchParams.set("provider", provider);
            return c.redirect(url.toString(), 302);
          }
          return c.json({
            status: "success",
            provider,
            credential_id: credentialId,
            credentials: credentials.map((cr) => ({
              id: cr.id,
              provider: cr.provider,
              label: cr.label,
            })),
          });
        }

        const { authorizationUrl } = await service.initiateInstall(
          provider,
          redirect_uri,
          userId,
          credential_id,
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
    .post("/:provider/reconcile", async (c) => {
      const provider = c.req.param("provider");

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
    );
}

export function mapAppInstallErrorToResponse(c: Context, e: AppInstallError) {
  switch (e.code) {
    case "STATE_INVALID":
    case "INVALID_PROVIDER_TYPE":
    case "MISSING_CODE":
    case "APPROVAL_PENDING":
    case "NOT_REFRESHABLE":
      return c.json({ error: e.code, message: e.message }, 400);
    case "PROVIDER_NOT_FOUND":
      return c.json({ error: e.code, message: e.message }, 404);
    case "INSTALLATION_OWNED":
      return c.json({ error: e.code, message: e.message }, 403);
    case "SLACK_NETWORK_ERROR":
    case "SLACK_HTTP_ERROR":
    case "SLACK_PARSE_ERROR":
    case "SLACK_OAUTH_ERROR":
    case "SLACK_REFRESH_ERROR":
    case "REFRESH_ERROR":
      return c.json({ error: e.code, message: e.message }, 502);
    case "CREDENTIAL_NOT_FOUND":
    case "INVALID_CREDENTIAL":
      return c.json({ error: e.code, message: e.message }, 500);
    default:
      return c.json({ error: "unknown_error", message: e.message }, 500);
  }
}
