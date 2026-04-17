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

  // Platform pass-through — forwards raw webhook to atlasd's platform
  // signal endpoint. Use this for Chat SDK adapters (Telegram, Slack) that
  // handle signature verification + parsing internally.
  //
  // URL pattern: /platform/{provider}/{...suffix}
  //   e.g. /platform/telegram/<bot_token_suffix>
  //        /platform/slack
  app.all("/platform/:provider/:suffix?", async (c) => {
    const { provider, suffix } = c.req.param();
    const basePath = suffix
      ? `${config.atlasdUrl}/signals/${provider}/${suffix}`
      : `${config.atlasdUrl}/signals/${provider}`;
    // Preserve query string — Meta/Slack/etc. verification handshakes carry
    // data in the query (e.g. hub.verify_token, hub.challenge for WhatsApp).
    const incomingQuery = new URL(c.req.raw.url).search;
    const upstream = `${basePath}${incomingQuery}`;

    // Forward raw body + all headers (Chat SDK needs them for verification)
    const body = await c.req.arrayBuffer();
    const headers = new Headers(c.req.raw.headers);
    headers.delete("host");
    headers.delete("content-length");

    logger.info("Platform webhook received", {
      provider,
      suffix,
      upstream,
      bodyBytes: body.byteLength,
    });

    try {
      const res = await fetch(upstream, {
        method: c.req.method,
        headers,
        body: body.byteLength > 0 ? body : undefined,
      });
      const resBody = await res.arrayBuffer();
      return new Response(resBody, { status: res.status, headers: res.headers });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error("Platform forward failed", { provider, suffix, error: msg });
      return c.json({ error: `Cannot reach atlasd: ${msg}` }, 502);
    }
  });

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
