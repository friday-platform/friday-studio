/**
 * Summary Routes
 * Aggregated view of providers and credentials for UI consumption
 */

import { logger } from "@atlas/logger";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { factory } from "../factory.ts";
import { registry } from "../providers/registry.ts";
import type { Credential, StorageAdapter } from "../types.ts";

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

export function createSummaryRoutes(storage: StorageAdapter) {
  return factory
    .createApp()
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

        let credentials: Array<(typeof baseCredentials)[number] & { status?: string }> = [];
        for (const cred of baseCredentials) {
          const full = await storage.get(cred.id, userId);
          credentials.push({ ...cred, status: computeCredentialStatus(full) });
        }

        if (provider) {
          credentials = credentials.filter((c) => c.provider === provider);
        }

        return c.json({ providers, credentials });
      } catch (error) {
        logger.error("Failed to get summary", { error });
        return c.json({ error: "Failed to get summary" }, 500);
      }
    });
}
