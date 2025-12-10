/**
 * Credentials Routes
 * Public and internal credential management endpoints
 */

import { logger } from "@atlas/logger";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { factory } from "../factory.ts";
import * as oauth from "../oauth/client.ts";
import { discoverAuthorizationServer } from "../oauth/discovery.ts";
import type { OAuthService } from "../oauth/service.ts";
import { buildStaticAuthServer, getStaticClientAuth } from "../oauth/static.ts";
import { revokeToken } from "../oauth/tokens.ts";
import { registry } from "../providers/registry.ts";
import { generateId } from "../service.ts";
import {
  type Credential,
  CredentialCreateRequestSchema,
  type CredentialSummary,
  CredentialTypeSchema,
  type OAuthCredential,
  type StorageAdapter,
} from "../types.ts";

/**
 * Create public credentials router with CRUD endpoints.
 * Mounted at /v1/credentials in main app.
 *
 * @param storage - Storage adapter for credential persistence
 * @param oauthService - OAuth service for token management
 * @returns Hono router with public credential endpoints
 */
export function createCredentialsRoutes(storage: StorageAdapter, _oauthService: OAuthService) {
  return (
    factory
      .createApp()
      /**
       * PUT /:type
       * Create or update credential of specified type
       */
      .put(
        "/:type",
        zValidator("param", z.object({ type: CredentialTypeSchema })),
        zValidator("json", CredentialCreateRequestSchema),
        async (c) => {
          const userId = c.get("userId");
          const { type } = c.req.valid("param");
          const { provider, label, secret } = c.req.valid("json");

          // Validate provider exists in registry
          const providerDef = registry.get(provider);
          if (!providerDef) {
            return c.json(
              { error: "unknown_provider", message: `Provider '${provider}' is not registered` },
              400,
            );
          }

          // Only apikey providers can have credentials created this way
          if (providerDef.type !== "apikey") {
            return c.json(
              {
                error: "invalid_provider_type",
                message: "Cannot create credentials for OAuth providers via this endpoint",
              },
              400,
            );
          }

          // Validate secret against provider schema
          const secretResult = providerDef.secretSchema.safeParse(secret);
          if (!secretResult.success) {
            const firstIssue = secretResult.error.issues[0];
            return c.json(
              {
                error: "validation_failed",
                message: firstIssue?.message ?? "Secret validation failed",
                provider,
                issues: secretResult.error.issues,
              },
              400,
            );
          }

          if (providerDef.health) {
            const healthResult = await providerDef.health(secretResult.data);
            if (!healthResult.healthy) {
              return c.json(
                { error: "health_check_failed", message: healthResult.error, provider },
                400,
              );
            }
          }

          try {
            const id = generateId();
            const now = new Date().toISOString();

            const credential: Credential = {
              id,
              type,
              provider,
              label,
              secret: secretResult.data,
              metadata: { createdAt: now, updatedAt: now },
            };

            // Persist credential
            await storage.save(credential, userId);

            // Return summary without secret
            const { secret: _, ...summary } = credential;
            return c.json(summary as CredentialSummary, 201);
          } catch (error) {
            logger.error("Failed to save credential", { error });
            return c.json({ error: "Failed to save credential" }, 500);
          }
        },
      )
      /**
       * GET /type/:type
       * List all credentials of specified type
       */
      .get(
        "/type/:type",
        zValidator("param", z.object({ type: CredentialTypeSchema })),
        async (c) => {
          const userId = c.get("userId");
          const { type } = c.req.valid("param");

          try {
            const credentials = await storage.list(type, userId);
            return c.json(credentials);
          } catch (error) {
            logger.error("Failed to list credentials", { error });
            return c.json({ error: "Failed to list credentials" }, 500);
          }
        },
      )
      /**
       * GET /:id
       * Get credential summary (no secrets)
       */
      .get("/:id", zValidator("param", z.object({ id: z.string() })), async (c) => {
        const userId = c.get("userId");
        const { id } = c.req.valid("param");

        try {
          const credential = await storage.get(id, userId);

          if (!credential) {
            return c.json({ error: "Credential not found" }, 404);
          }

          // Strip secret field to return CredentialSummary
          const { secret: _, ...summary } = credential;
          return c.json(summary);
        } catch (error) {
          logger.error("Failed to retrieve credential", { error });
          return c.json({ error: "Failed to retrieve credential" }, 500);
        }
      })
      /**
       * DELETE /:id
       * Delete credential with optional OAuth token revocation
       */
      .delete("/:id", zValidator("param", z.object({ id: z.string() })), async (c) => {
        const userId = c.get("userId");
        const { id } = c.req.valid("param");

        try {
          // Check if credential exists first for proper 404
          const existing = await storage.get(id, userId);
          if (!existing) {
            return c.json({ error: "Credential not found" }, 404);
          }

          // Attempt token revocation for OAuth credentials (best-effort, RFC 7009)
          if (existing.type === "oauth") {
            const secret = existing.secret as { access_token?: string; client_id?: string };
            if (secret.access_token) {
              const provider = registry.get(existing.provider);
              if (provider?.type === "oauth") {
                let authServer: oauth.AuthorizationServer;
                let clientAuth: oauth.ClientAuth;
                let clientId: string;

                if (provider.oauthConfig.mode === "static") {
                  authServer = buildStaticAuthServer(provider.oauthConfig);
                  clientAuth = getStaticClientAuth(provider.oauthConfig);
                  clientId = provider.oauthConfig.clientId;
                } else {
                  // Discovery mode - fresh discovery for revocation
                  authServer = await discoverAuthorizationServer(provider.oauthConfig.serverUrl);
                  clientAuth = oauth.None();
                  clientId = secret.client_id as string;
                }

                await revokeToken(
                  authServer,
                  { client_id: clientId },
                  clientAuth,
                  secret.access_token,
                );
              }
            }
          }

          // Delete the credential
          await storage.delete(id, userId);

          // Return 204 No Content on success
          return c.body(null, 204);
        } catch (error) {
          logger.error("Failed to delete credential", { error });
          return c.json({ error: "Failed to delete credential" }, 500);
        }
      })
  );
}

/**
 * Create internal credentials router for runtime access.
 * Mounted at /internal/v1/credentials in main app.
 *
 * @param storage - Storage adapter for credential access
 * @param oauthService - OAuth service for proactive token refresh
 * @returns Hono router with internal credential endpoint
 */
export function createInternalCredentialsRoutes(
  storage: StorageAdapter,
  oauthService: OAuthService,
) {
  return (
    factory
      .createApp()
      /**
       * GET /:id
       * Get credential with secrets and proactive OAuth refresh
       */
      .get("/:id", zValidator("param", z.object({ id: z.string() })), async (c) => {
        const userId = c.get("userId");
        const { id } = c.req.valid("param");

        try {
          const credential = await storage.get(id, userId);

          if (!credential) {
            return c.json({ error: "credential_not_found" }, 404);
          }

          // Non-OAuth credentials are always ready
          if (credential.type !== "oauth") {
            return c.json({ credential, status: "ready" });
          }

          const REFRESH_BUFFER_SECONDS = 5 * 60; // 5 minutes
          const now = Math.floor(Date.now() / 1000);
          const expiresAt = credential.secret.expires_at as number | undefined;

          // Not expiring soon (or no expiry set)
          if (!expiresAt || expiresAt > now + REFRESH_BUFFER_SECONDS) {
            return c.json({ credential, status: "ready" });
          }

          // Expiring soon but no refresh token
          if (!credential.secret.refresh_token) {
            return c.json({ credential, status: "expired_no_refresh" });
          }

          // Try refresh
          try {
            const refreshed = await oauthService.refreshCredential(
              credential as OAuthCredential,
              userId,
            );
            return c.json({ credential: refreshed, status: "refreshed" });
          } catch (e) {
            const message = e instanceof Error ? e.message : "Unknown error";
            return c.json({ credential, status: "refresh_failed", error: message });
          }
        } catch (error) {
          logger.error("Failed to retrieve credential", { error });
          return c.json({ error: "Failed to retrieve credential" }, 500);
        }
      })
  );
}
