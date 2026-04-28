/**
 * Summary Routes
 * Aggregated view of providers and credentials for UI consumption
 */

import { logger } from "@atlas/logger";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import type { CommunicatorWiringRepository } from "../adapters/communicator-wiring-repository.ts";
import { factory } from "../factory.ts";
import { SLACK_APP_PROVIDER } from "../providers/constants.ts";
import { registry } from "../providers/registry.ts";
import type { Credential, StorageAdapter } from "../types.ts";

const COMMUNICATOR_CREDENTIAL_PROVIDERS = [SLACK_APP_PROVIDER];

function computeCredentialStatus(credential: Credential | null): "ready" | "expired" | "unknown" {
  if (!credential) return "unknown";

  if (credential.type === "apikey") {
    return "ready";
  }

  if (credential.type === "oauth") {
    const secret = credential.secret as { expires_at?: number; refresh_token?: string };

    if (typeof secret.expires_at !== "number") {
      return "ready";
    }

    const REFRESH_BUFFER_SECONDS = 5 * 60;
    const now = Math.floor(Date.now() / 1000);

    if (secret.expires_at > now + REFRESH_BUFFER_SECONDS) {
      return "ready";
    }

    if (secret.refresh_token) {
      return "ready";
    }

    return "expired";
  }

  return "unknown";
}

export function createSummaryRoutes(
  storage: StorageAdapter,
  wiringRepo: CommunicatorWiringRepository,
) {
  return (
    factory
      .createApp()
      /**
       * Aggregate providers and credentials. Slack-app credentials are
       * enriched with `wiredWorkspaceId` — null when the credential exists
       * but is not currently wired (e.g. after a disconnect that left the
       * bot around because it was still referenced elsewhere).
       */
      .get("/", zValidator("query", z.object({ provider: z.string().optional() })), async (c) => {
        const userId = c.get("userId");
        const { provider } = c.req.valid("query");

        try {
          const allProviders = await registry.list();
          const providers = allProviders.map((p) => ({
            id: p.id,
            displayName: p.displayName,
            type: p.type,
          }));

          const oauthCredentials = await storage.list("oauth", userId);
          const apikeyCredentials = await storage.list("apikey", userId);

          const baseCredentials = [...oauthCredentials, ...apikeyCredentials].map((c) => ({
            id: c.id,
            type: c.type,
            provider: c.provider,
            label: c.label,
            displayName: c.displayName ?? null,
            userIdentifier: c.userIdentifier ?? null,
            isDefault: c.isDefault,
            createdAt: c.metadata.createdAt,
            updatedAt: c.metadata.updatedAt,
          }));

          // Sequential resolution — users have 1-2 bots in practice.
          let credentials: Array<
            (typeof baseCredentials)[number] & { wiredWorkspaceId?: string | null; status?: string }
          > = [];
          for (const cred of baseCredentials) {
            const full = await storage.get(cred.id, userId);
            const status = computeCredentialStatus(full);

            if (!COMMUNICATOR_CREDENTIAL_PROVIDERS.includes(cred.provider)) {
              credentials.push({ ...cred, status });
              continue;
            }
            const mapping = await wiringRepo.findByCredentialId(userId, cred.id);
            credentials.push({ ...cred, wiredWorkspaceId: mapping?.workspaceId ?? null, status });
          }

          if (provider) {
            credentials = credentials.filter((c) => c.provider === provider);
          }

          return c.json({ providers, credentials });
        } catch (error) {
          logger.error("Failed to get summary", { error });
          return c.json({ error: "Failed to get summary" }, 500);
        }
      })
  );
}
