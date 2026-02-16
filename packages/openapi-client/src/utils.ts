/**
 * Utilities for OpenAPI client
 */

// Declare process for Node.js compatibility
declare const process: { env: Record<string, string | undefined> } | undefined;

// Declare __TAURI_BUILD__ for Vite builds
declare const __TAURI_BUILD__: boolean | undefined;

// Declare __DEV_MODE__ for Vite dev server
declare const __DEV_MODE__: boolean | undefined;

/**
 * Get the Atlas daemon URL from environment or default
 * Works in Node.js and browser (Tauri/web) environments
 *
 * Priority order:
 * 1. Dev mode (Vite dev server) → http://127.0.0.1:8080 (direct connection)
 * 2. Production web builds (browser) → window.location.origin (same-origin, routed by Traefik)
 * 3. Production web builds (SSR) → "" (relative URLs for SvelteKit's fetch)
 * 4. process.env.ATLAS_DAEMON_URL (Node.js)
 * 5. globalThis.ATLAS_DAEMON_URL (Tauri)
 * 6. Default: http://127.0.0.1:8080
 */
export function getAtlasDaemonUrl(): string {
  // In production web builds (not dev mode, not Tauri)
  if (
    typeof __TAURI_BUILD__ !== "undefined" &&
    __TAURI_BUILD__ === false &&
    typeof __DEV_MODE__ !== "undefined" &&
    __DEV_MODE__ === false
  ) {
    // In browser context, return origin for proper URL constructor support
    // During SSR, window is undefined - fall back to empty string for relative URLs
    if (typeof window !== "undefined" && globalThis.location?.origin) {
      return globalThis.location.origin;
    }
    return "";
  }

  // Try to get from environment
  let daemonUrl: string | undefined;
  if (process?.env) {
    daemonUrl = process.env.ATLAS_DAEMON_URL;
  }

  // Check globalThis (set by Tauri)
  if (!daemonUrl && typeof globalThis !== "undefined") {
    // @ts-expect-error - globalThis.ATLAS_DAEMON_URL may be set by Tauri
    daemonUrl = globalThis.ATLAS_DAEMON_URL;
  }

  return daemonUrl || "http://127.0.0.1:8080";
}

/**
 * Get the atlas-platform MCP server config pointing at the daemon's /mcp endpoint.
 */
export function getAtlasPlatformServerConfig() {
  return { transport: { type: "http" as const, url: `${getAtlasDaemonUrl()}/mcp` } };
}
