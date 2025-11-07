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
 * Works in Deno, Node.js, and browser (Tauri/web) environments
 *
 * Priority order:
 * 1. Dev mode (Vite dev server) → http://127.0.0.1:8080 (direct connection)
 * 2. Production web builds → "" (relative URLs, routed by Traefik)
 * 3. Deno.env.ATLAS_DAEMON_URL
 * 4. process.env.ATLAS_DAEMON_URL (Node.js)
 * 5. globalThis.ATLAS_DAEMON_URL (Tauri)
 * 6. Default: http://127.0.0.1:8080
 */
export function getAtlasDaemonUrl(): string {
  // In production web builds (not dev mode, not Tauri), use relative URLs
  if (
    typeof __TAURI_BUILD__ !== "undefined" &&
    __TAURI_BUILD__ === false &&
    typeof __DEV_MODE__ !== "undefined" &&
    __DEV_MODE__ === false
  ) {
    return "";
  }

  // Try to get from environment in a cross-platform way
  let daemonUrl: string | undefined;

  // Check Deno environment
  if (typeof Deno !== "undefined" && Deno.env) {
    daemonUrl = Deno.env.get("ATLAS_DAEMON_URL");
  }
  // Check Node.js environment (but not Vite's stub process.env = {})
  else if (
    typeof process !== "undefined" &&
    process?.env &&
    typeof process.env.NODE_ENV !== "undefined"
  ) {
    daemonUrl = process.env.ATLAS_DAEMON_URL;
  }
  // Check globalThis (set by Tauri)
  if (!daemonUrl && typeof globalThis !== "undefined") {
    // @ts-expect-error - globalThis.ATLAS_DAEMON_URL may be set by Tauri
    daemonUrl = globalThis.ATLAS_DAEMON_URL;
  }

  return daemonUrl || "http://127.0.0.1:8080";
}
