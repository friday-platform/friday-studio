/**
 * Summary Routes
 * Aggregated view of providers and credentials for UI consumption
 */

import { logger } from "@atlas/logger";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { factory } from "../factory.ts";
import { registry } from "../providers/registry.ts";
import type { StorageAdapter } from "../types.ts";

/**
 * Create summary router with aggregated endpoint.
 * Mounted at /v1/summary in main app.
 *
 * @param storage - Storage adapter for credential access
 * @returns Hono router with summary endpoint
 */
export function createSummaryRoutes(storage: StorageAdapter) {
  return (
    factory
      .createApp()
      /**
       * GET /
       * Aggregate providers and credentials into single response
       * Query params:
       *   - provider (optional): Filter credentials by provider ID
       */
      .get("/", zValidator("query", z.object({ provider: z.string().optional() })), async (c) => {
        const userId = c.get("userId");
        const { provider } = c.req.valid("query");

        try {
          // Get all providers from registry
          const allProviders = await registry.list();
          const providers = allProviders.map((p) => ({
            id: p.id,
            displayName: p.displayName,
            type: p.type,
          }));

          // Get credentials from both types
          const oauthCredentials = await storage.list("oauth", userId);
          const apikeyCredentials = await storage.list("apikey", userId);

          // Combine and map to response shape (already no secrets from list())
          let credentials = [...oauthCredentials, ...apikeyCredentials].map((c) => ({
            id: c.id,
            type: c.type,
            provider: c.provider,
            label: c.label,
            displayName: c.displayName ?? null,
            userIdentifier: c.userIdentifier ?? null,
            createdAt: c.metadata.createdAt,
            updatedAt: c.metadata.updatedAt,
          }));

          // Filter by provider if query param provided
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
