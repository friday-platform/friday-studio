/**
 * Utilities for OpenAPI client
 */

// Declare process for Node.js compatibility
declare const process: { env: Record<string, string | undefined> } | undefined;

// Declare __DEV_MODE__ for Vite dev server
declare const __DEV_MODE__: boolean | undefined;

/**
 * Get the Atlas daemon URL from environment or default
 * Works in Node.js and browser environments
 *
 * Priority order:
 * 1. Dev mode (Vite dev server) → http://127.0.0.1:8080 (direct connection)
 * 2. Production web builds (browser) → window.location.origin (same-origin, routed by Traefik)
 * 3. Production web builds (SSR) → "" (relative URLs for SvelteKit's fetch)
 * 4. process.env.FRIDAYD_URL (canonical — set by friday-launcher's
 *    commonServiceEnv() and the installer wizard's .env writer)
 * 5. process.env.FRIDAY_DAEMON_URL (legacy alias — kept for older
 *    in-tree callers / tests that still set it)
 * 6. process.env.FRIDAY_PORT_FRIDAY → http://127.0.0.1:<port>
 * 7. Default: http://127.0.0.1:8080
 */
export function getAtlasDaemonUrl(): string {
  // In production web builds (not dev mode)
  if (typeof __DEV_MODE__ !== "undefined" && __DEV_MODE__ === false) {
    // In browser context, return origin for proper URL constructor support
    // During SSR, window is undefined - fall back to empty string for relative URLs
    if (typeof window !== "undefined" && globalThis.location?.origin) {
      return globalThis.location.origin;
    }
    return "";
  }

  // Node.js / Deno-compile path. The launcher's commonServiceEnv()
  // exports FRIDAYD_URL (matching the wizard's .env writer); older
  // callers and tests set FRIDAY_DAEMON_URL — accept either. Falling
  // back to FRIDAY_PORT_FRIDAY catches the case where the launcher
  // exported the port-override knob without the convenience URL var
  // (e.g. user manually edited .env and only set FRIDAY_PORT_FRIDAY).
  // The explicit "let-the-self-loopback-find-the-daemon" chain here
  // is what makes a port-overridden install reach its own daemon —
  // without it, workspace-chat agent's fetchWorkspaceDetails fires at
  // the hardcoded 127.0.0.1:8080 and the chat returns "messages: at
  // least one message is required" because the workspace context comes
  // back empty (Connection refused → silently empty messages array).
  if (process?.env) {
    const explicit = process.env.FRIDAYD_URL || process.env.FRIDAY_DAEMON_URL;
    if (explicit) return explicit;
    const port = process.env.FRIDAY_PORT_FRIDAY;
    if (port) return `http://127.0.0.1:${port}`;
  }

  return "http://127.0.0.1:8080";
}

/**
 * Get the atlas-platform MCP server config pointing at the daemon's /mcp endpoint.
 *
 * `FRIDAY_ATLAS_PLATFORM_URL` overrides the URL when atlas-platform is
 * deployed as a separate shared service. This lets a cloud
 * deployment run one atlas-platform pod fronted by Traefik / a Service
 * and have N daemons all point at the same URL, instead of every daemon
 * embedding its own copy. Default — and the only path on a single-host
 * install — is "same host as the daemon".
 */
export function getAtlasPlatformServerConfig() {
  const override =
    typeof process !== "undefined" && process?.env?.FRIDAY_ATLAS_PLATFORM_URL
      ? process.env.FRIDAY_ATLAS_PLATFORM_URL
      : undefined;
  const url = override ?? `${getAtlasDaemonUrl()}/mcp`;
  return { transport: { type: "http" as const, url } };
}
