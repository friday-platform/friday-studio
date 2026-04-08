/**
 * Summary Routes
 * Aggregated view of providers and credentials for UI consumption
 */

import { logger } from "@atlas/logger";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import type { SlackAppWorkspaceRepository } from "../adapters/slack-app-workspace-repository.ts";
import { factory } from "../factory.ts";
import { registry } from "../providers/registry.ts";
import type { StorageAdapter } from "../types.ts";

export function createSummaryRoutes(
  storage: StorageAdapter,
  slackAppWorkspaceRepo: SlackAppWorkspaceRepository,
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
            (typeof baseCredentials)[number] & { wiredWorkspaceId?: string | null }
          > = [];
          for (const cred of baseCredentials) {
            if (cred.provider !== "slack-app") {
              credentials.push(cred);
              continue;
            }
            const mapping = await slackAppWorkspaceRepo.findByCredentialId(cred.id, userId);
            credentials.push({ ...cred, wiredWorkspaceId: mapping?.workspaceId ?? null });
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
