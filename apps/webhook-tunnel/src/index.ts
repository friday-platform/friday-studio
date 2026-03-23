/**
 * Webhook Tunnel — receives external webhooks via a Cloudflare tunnel
 * and forwards them to atlasd as workspace signal triggers.
 *
 * URL pattern: /hook/{provider}/{workspaceId}/{signalId}
 *
 * Environment:
 *   ATLASD_URL      — Daemon API URL (default: http://localhost:8080)
 *   WEBHOOK_SECRET  — Shared secret for signature verification (optional)
 *   TUNNEL_PORT     — Local port for the webhook listener (default: 9090)
 *   TUNNEL_TOKEN    — Cloudflare tunnel token for stable URLs (optional)
 *   NO_TUNNEL       — Set to "true" to skip cloudflared (just run the server)
 */

import process from "node:process";
import { logger } from "@atlas/logger";
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Config } from "./config.ts";
import { readConfig } from "./config.ts";
import { listProviders } from "./providers.ts";
import { createWebhookRoutes } from "./routes.ts";
import { startTunnel, type TunnelResult } from "./tunnel.ts";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let server: Deno.HttpServer | null = null;
let tunnel: TunnelResult | null = null;
let tunnelUrl: string | null = null;
let isShuttingDown = false;

// ---------------------------------------------------------------------------
// App factory
// ---------------------------------------------------------------------------

export function createApp(config: Config) {
  const app = new Hono();

  // CORS for /status so the playground can fetch from browser
  app.use("/status", cors({ origin: "*" }));

  // Health
  app.get("/health", (c) => c.json({ status: "ok", service: "webhook-tunnel" }));

  // Tunnel status — used by the playground to construct webhook URLs
  app.get("/status", (c) =>
    c.json({
      url: tunnelUrl,
      secret: config.webhookSecret ?? null,
      providers: listProviders(),
      pattern: "/hook/{provider}/{workspaceId}/{signalId}",
      active: tunnelUrl !== null,
    }),
  );

  // Webhook routes
  app.route(
    "/",
    createWebhookRoutes(config, () => tunnelUrl),
  );

  return app;
}

export type WebhookTunnelApp = ReturnType<typeof createApp>;

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

async function shutdown(signal: string): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logger.info("Received signal, shutting down gracefully", { signal });

  const shutdownTimeout = setTimeout(() => {
    logger.error("Shutdown timeout, forcing exit");
    process.exit(1);
  }, 25_000);

  try {
    if (tunnel) {
      tunnel.stop();
      logger.info("Tunnel stopped");
    }

    if (server) {
      await server.shutdown();
      logger.info("HTTP server stopped");
    }

    clearTimeout(shutdownTimeout);
    logger.info("Shutdown complete");
    process.exit(0);
  } catch (error) {
    clearTimeout(shutdownTimeout);
    logger.error("Error during shutdown", { error });
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const config = readConfig();
  const app = createApp(config);

  // Signal handlers
  Deno.addSignalListener("SIGINT", () => shutdown("SIGINT"));
  Deno.addSignalListener("SIGTERM", () => shutdown("SIGTERM"));

  // Start HTTP server
  server = Deno.serve({ port: config.port, hostname: "0.0.0.0", onListen: () => {} }, app.fetch);

  logger.info("Webhook listener started", {
    port: config.port,
    atlasdUrl: config.atlasdUrl,
    secret: config.webhookSecret ? "configured" : "none",
  });

  // Start tunnel
  if (!config.noTunnel) {
    logger.info("Starting cloudflared tunnel...");
    try {
      tunnel = await startTunnel(config.port, config.tunnelToken);
      tunnelUrl = tunnel.url;

      logger.info("Webhook tunnel ready", { publicUrl: tunnelUrl });

      // Also print to stdout for easy copy-paste (this is a CLI tool)
      console.log("");
      console.log("================================================================");
      console.log("  Webhook Tunnel ready!");
      console.log("");
      console.log(`  Public URL:  ${tunnelUrl}`);
      console.log("");
      console.log("  Register webhooks using:");
      console.log(`    ${tunnelUrl}/hook/{provider}/{workspaceId}/{signalId}`);
      console.log("");
      console.log("  Examples:");
      console.log(`    GitHub:     ${tunnelUrl}/hook/github/{workspaceId}/review-pr`);
      console.log(`    Bitbucket:  ${tunnelUrl}/hook/bitbucket/{workspaceId}/review-pr`);
      console.log(`    Raw:        ${tunnelUrl}/hook/raw/{workspaceId}/{signalId}`);
      console.log("================================================================");
      console.log("");
    } catch (tunnelErr) {
      const msg = tunnelErr instanceof Error ? tunnelErr.message : String(tunnelErr);
      logger.error("Failed to start tunnel", { error: msg });
      logger.info("Server is still running on localhost", {
        localUrl: `http://localhost:${config.port}/hook/{provider}/{workspaceId}/{signalId}`,
      });
    }
  } else {
    logger.info("Tunnel disabled", {
      localUrl: `http://localhost:${config.port}/hook/{provider}/{workspaceId}/{signalId}`,
    });
  }
}
