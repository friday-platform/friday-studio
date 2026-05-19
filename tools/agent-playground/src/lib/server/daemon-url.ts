import { env } from "node:process";

/**
 * Vite injects these constants for SSR-transformed modules in dev. The
 * compiled static server does not run through Vite, so the runtime-env
 * branches below are the production path.
 */
declare const __FRIDAY_DAEMON_BASE_URL__: string | undefined;
declare const __FRIDAY_TUNNEL_BASE_URL__: string | undefined;

function s2sScheme(): "http" | "https" {
  return env.FRIDAY_TLS_CERT && env.FRIDAY_TLS_KEY ? "https" : "http";
}

/**
 * Resolve the daemon URL for server-side callers.
 *
 * Dev uses Vite's injected URL so the value survives `process.env` define
 * rewriting. The compiled binary reads runtime env directly, matching the
 * launcher-managed TLS/port configuration.
 */
export function effectiveDaemonUrl(): string {
  if (typeof __FRIDAY_DAEMON_BASE_URL__ !== "undefined") {
    return __FRIDAY_DAEMON_BASE_URL__;
  }
  return env.FRIDAYD_URL ?? `${s2sScheme()}://localhost:8080`;
}

/**
 * Resolve the webhook-tunnel URL for server-side callers. Same dev/prod
 * split as {@link effectiveDaemonUrl}; the launcher writes
 * `EXTERNAL_TUNNEL_URL` into .env so the compiled binary picks it up at
 * runtime.
 */
export function effectiveTunnelUrl(): string {
  if (typeof __FRIDAY_TUNNEL_BASE_URL__ !== "undefined") {
    return __FRIDAY_TUNNEL_BASE_URL__;
  }
  return env.EXTERNAL_TUNNEL_URL ?? `${s2sScheme()}://localhost:9090`;
}
