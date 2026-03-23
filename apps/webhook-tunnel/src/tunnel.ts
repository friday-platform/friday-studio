/**
 * Cloudflared tunnel manager using the `cloudflared` npm package.
 *
 * Supports two modes:
 *   - Quick Tunnel: free, random URL, no account needed
 *   - Token Tunnel: stable URL, requires cloudflare account token
 */

import { existsSync } from "node:fs";
import { logger } from "@atlas/logger";
import { bin, install, Tunnel, use } from "cloudflared";

export interface TunnelResult {
  url: string;
  stop: () => void;
}

/**
 * Ensure the cloudflared binary is available.
 *
 * Priority:
 *   1. System-installed cloudflared (in PATH)
 *   2. npm package binary (auto-installed if missing)
 */
async function ensureBinary(): Promise<void> {
  // Check if system cloudflared exists
  const systemPaths = ["/opt/homebrew/bin/cloudflared", "/usr/local/bin/cloudflared"];
  for (const p of systemPaths) {
    if (existsSync(p)) {
      use(p);
      logger.debug("Using system cloudflared", { path: p });
      return;
    }
  }

  // Fall back to npm package binary
  if (!existsSync(bin)) {
    logger.info("Installing cloudflared binary...");
    await install(bin);
  }
  logger.debug("Using npm cloudflared", { path: bin });
}

/**
 * Start a cloudflared tunnel pointing at the given local port.
 *
 * Quick mode:  random trycloudflare.com URL (no account)
 * Token mode:  stable URL via `TUNNEL_TOKEN` env var
 */
export async function startTunnel(port: number, tunnelToken?: string): Promise<TunnelResult> {
  await ensureBinary();

  const t = tunnelToken
    ? Tunnel.withToken(tunnelToken, { "--url": `http://localhost:${port}` })
    : Tunnel.quick(`http://localhost:${port}`);

  // Wait for the public URL (emitted when tunnel is ready)
  const url = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Timed out waiting for cloudflared tunnel URL (30s)"));
    }, 30_000);

    t.once("url", (u) => {
      clearTimeout(timeout);
      resolve(u);
    });

    t.once("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });

  return { url, stop: t.stop };
}
