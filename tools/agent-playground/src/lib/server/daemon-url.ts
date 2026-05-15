import { env } from "node:process";

/**
 * Vite injects this constant for SSR-transformed Hono routes in dev. The
 * compiled static server does not run through Vite, so the runtime-env branch
 * below is the production path.
 */
declare const __FRIDAY_DAEMON_BASE_URL__: string | undefined;

/**
 * Resolve the daemon URL for server-side Hono routes.
 *
 * Dev uses Vite's injected URL so the route survives `process.env` define
 * rewriting. The compiled binary reads runtime env directly, matching
 * `static-server.ts` and the launcher-managed TLS/port configuration.
 */
export function effectiveDaemonUrl(): string {
  if (typeof __FRIDAY_DAEMON_BASE_URL__ !== "undefined") {
    return __FRIDAY_DAEMON_BASE_URL__;
  }

  const s2sScheme = env.FRIDAY_TLS_CERT && env.FRIDAY_TLS_KEY ? "https" : "http";
  return env.FRIDAYD_URL ?? `${s2sScheme}://localhost:8080`;
}
