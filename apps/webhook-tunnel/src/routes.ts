/**
 * Webhook tunnel routes — modular factory function.
 */

import { logger } from "@atlas/logger";
import { Hono } from "hono";
import type { Config } from "./config.ts";
import { getProvider, listProviders } from "./providers.ts";

/**
 * Create the webhook routes.
 *
 * @param config - Validated tunnel config
 * @param getTunnelUrl - Returns the current tunnel URL (null if not yet connected)
 */
export function createWebhookRoutes(config: Config, getTunnelUrl: () => string | null) {
  const app = new Hono();

  // List available providers + tunnel status
  app.get("/", (c) =>
    c.json({
      service: "webhook-tunnel",
      providers: listProviders(),
      pattern: "/hook/{provider}/{workspaceId}/{signalId}",
      url: getTunnelUrl(),
    }),
  );

  // Main webhook handler
  app.post("/hook/:provider/:workspaceId/:signalId", async (c) => {
    const { provider, workspaceId, signalId } = c.req.param();

    // 1. Resolve provider
    const handler = getProvider(provider);
    if (!handler) {
      return c.json(
        { error: `Unknown provider: ${provider}. Available: ${listProviders().join(", ")}` },
        400,
      );
    }

    // 2. Verify signature
    const verifyError = await handler.verify(c, config.webhookSecret);
    if (verifyError) {
      logger.error("Signature verification failed", { provider, error: verifyError });
      return c.json({ error: verifyError }, 401);
    }

    // 3. Transform payload (returns null for events we should skip)
    const result = await handler.transform(c);
    if (!result) {
      logger.debug("Event skipped", { provider, reason: "irrelevant event" });
      return c.json({ status: "skipped", reason: "irrelevant event" }, 200);
    }

    logger.info("Webhook received", {
      provider,
      description: result.description,
      workspaceId,
      signalId,
    });

    // 4. Forward to atlasd
    try {
      const url = `${config.atlasdUrl}/api/workspaces/${workspaceId}/signals/${signalId}`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ payload: result.payload }),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        logger.error("Signal trigger failed", {
          provider,
          workspaceId,
          signalId,
          status: res.status,
          body,
        });
        return c.json({ error: `Signal trigger failed: ${res.status}`, detail: body }, 502);
      }

      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      const sessionId = typeof data.sessionId === "string" ? data.sessionId : undefined;
      logger.info("Signal triggered", { provider, workspaceId, signalId, sessionId });
      return c.json({ status: "forwarded", sessionId }, 200);
    } catch (fetchErr) {
      const msg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
      logger.error("Failed to reach atlasd", { provider, workspaceId, signalId, error: msg });
      return c.json({ error: `Cannot reach atlasd at ${config.atlasdUrl}: ${msg}` }, 502);
    }
  });

  return app;
}
