/**
 * Internal routes for generic communicator wiring operations.
 * Mounted at /internal/v1/communicator.
 *
 * Handles disconnect, wiring queries, and connection resolution
 * for all communicator providers (Slack, external-chat, etc.).
 */

import { logger } from "@atlas/logger";
import { stringifyError } from "@atlas/utils";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import type { CommunicatorWiringRepository } from "../adapters/communicator-wiring-repository.ts";
import { factory } from "../factory.ts";
import type { ProviderRegistry } from "../providers/registry.ts";
import type { StorageAdapter } from "../types.ts";

const DisconnectSchema = z.object({
  workspace_id: z.string().min(1),
  provider: z.string().min(1),
  callback_base_url: z.string().url().optional(),
});

const WireSchema = z.object({
  workspace_id: z.string().min(1),
  provider: z.string().min(1),
  credential_id: z.string().min(1),
  connection_id: z.string().min(1),
  callback_base_url: z.string().url(),
});

const WiringQuerySchema = z.object({
  workspace_id: z.string().min(1).optional(),
  provider: z.string().min(1).optional(),
});

const ResolveQuerySchema = z.object({
  connection_id: z.string().min(1),
  provider: z.string().min(1),
});

export function createCommunicatorRoutes(
  wiringRepo: CommunicatorWiringRepository,
  storage: StorageAdapter,
  registry: ProviderRegistry,
) {
  return (
    factory
      .createApp()

      /**
       * Wire a credential to a workspace for a given communicator provider.
       * Idempotent — the underlying repository upserts on
       * `(user_id, workspace_id, provider)`, so re-issuing a wire with a
       * different `credential_id` rewrites the binding.
       *
       * If the provider implements `registerWebhook`, it's called after the
       * wiring insert. A failure rolls the wiring back via
       * `deleteByCredentialId` and returns 500 — atomicity guarantee that a
       * wiring row only exists if the upstream platform accepted registration.
       */
      .post("/wire", zValidator("json", WireSchema), async (c) => {
        const { workspace_id, provider, credential_id, connection_id, callback_base_url } =
          c.req.valid("json");
        const userId = c.get("userId");

        await wiringRepo.insert(userId, credential_id, workspace_id, provider, connection_id);

        logger.info("communicator_wiring_inserted", {
          workspaceId: workspace_id,
          provider,
          credentialId: credential_id,
        });

        const providerDef = await registry.get(provider);
        if (providerDef?.type === "apikey" && providerDef.registerWebhook) {
          const credential = await storage.get(credential_id, userId);
          if (!credential) {
            await wiringRepo.deleteByCredentialId(userId, credential_id);
            return c.json({ error: `Credential not found: ${credential_id}` }, 500);
          }
          try {
            await providerDef.registerWebhook({
              secret: credential.secret,
              callbackBaseUrl: callback_base_url,
              connectionId: connection_id,
            });
          } catch (error) {
            await wiringRepo.deleteByCredentialId(userId, credential_id);
            const message = stringifyError(error);
            logger.error("communicator_webhook_register_failed", {
              workspaceId: workspace_id,
              provider,
              credentialId: credential_id,
              error: message,
            });
            return c.json({ error: message }, 500);
          }
        }

        return c.json({ ok: true });
      })

      /**
       * Disconnect a communicator from a workspace. If the provider implements
       * `unregisterWebhook`, it's called before the wiring is removed —
       * best-effort: failures are logged and disconnect proceeds. User intent
       * is to disconnect; we don't strand them on platform unreachability.
       */
      // TODO(stage-3): used by external-chat / signal-gateway. Verbatim from main 05f0157b1; do not modify until stage 3.
      .post("/disconnect", zValidator("json", DisconnectSchema), async (c) => {
        const { workspace_id, provider, callback_base_url } = c.req.valid("json");
        const userId = c.get("userId");

        const wiring = await wiringRepo.findByWorkspaceAndProvider(userId, workspace_id, provider);
        if (wiring) {
          const providerDef = await registry.get(provider);
          if (providerDef?.type === "apikey" && providerDef.unregisterWebhook) {
            const credential = await storage.get(wiring.credentialId, userId);
            if (credential) {
              try {
                await providerDef.unregisterWebhook({
                  secret: credential.secret,
                  callbackBaseUrl: callback_base_url ?? "",
                  connectionId: wiring.identifier,
                });
              } catch (error) {
                logger.warn("communicator_webhook_unregister_failed", {
                  workspaceId: workspace_id,
                  provider,
                  error: stringifyError(error),
                });
              }
            }
          }
        }

        const deleted = await wiringRepo.deleteByWorkspaceAndProvider(
          userId,
          workspace_id,
          provider,
        );

        logger.info("communicator_wiring_disconnected", {
          workspaceId: workspace_id,
          provider,
          credentialId: deleted?.credentialId ?? null,
        });

        return c.json({ credential_id: deleted?.credentialId ?? null });
      })

      /**
       * Query wiring state. Two modes:
       * - With workspace_id + provider: returns specific wiring (credential_id, connection_id)
       * - Without params: returns all wired workspace IDs for the authenticated user
       */
      .get("/wiring", zValidator("query", WiringQuerySchema), async (c) => {
        const { workspace_id, provider } = c.req.valid("query");
        const userId = c.get("userId");

        // Specific wiring lookup. Returns 200 { wiring: null } when no wiring
        // exists so callers can distinguish "not wired" from infrastructure 404s
        // (proxy misconfig, route not mounted, etc.).
        if (workspace_id && provider) {
          const wiring = await wiringRepo.findByWorkspaceAndProvider(
            userId,
            workspace_id,
            provider,
          );
          if (!wiring) {
            return c.json({ wiring: null });
          }
          return c.json({
            wiring: { credential_id: wiring.credentialId, connection_id: wiring.identifier },
          });
        }

        // List all wired workspace IDs
        const workspaceIds = await wiringRepo.listWiredWorkspaceIds(userId);
        return c.json({ workspace_ids: workspaceIds });
      })

      /**
       * Resolve a connection for inbound webhook routing. Returns workspace_id,
       * credential_id, and the credential secret in one call.
       */
      // TODO(stage-3): used by external-chat / signal-gateway. Verbatim from main 05f0157b1; do not modify until stage 3.
      .get("/resolve", zValidator("query", ResolveQuerySchema), async (c) => {
        const { connection_id, provider } = c.req.valid("query");
        const userId = c.get("userId");

        const wiring = await wiringRepo.findByConnectionAndProvider(
          userId,
          connection_id,
          provider,
        );
        if (!wiring) {
          return c.json({ error: "Unknown connection" }, 404);
        }

        const credential = await storage.get(wiring.credentialId, userId);
        if (!credential) {
          logger.warn("communicator_resolve_credential_not_found", {
            connectionId: connection_id,
            credentialId: wiring.credentialId,
          });
          return c.json({ error: "Credential not found" }, 404);
        }

        return c.json({
          workspace_id: wiring.workspaceId,
          credential_id: wiring.credentialId,
          secret: credential.secret,
        });
      })
  );
}
