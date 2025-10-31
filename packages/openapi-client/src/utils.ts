/**
 * Utilities for OpenAPI client
 */

// Declare process for Node.js compatibility
declare const process: { env: Record<string, string | undefined> } | undefined;

// Declare __TAURI_BUILD__ for Vite builds
declare const __TAURI_BUILD__: boolean | undefined;

/**
 * Get the Atlas daemon URL from environment or default
 * Works in Deno, Node.js, and browser (Tauri/web) environments
 *
 * Priority order:
 * 1. Web builds → "" (relative URLs, proxied by web-client server)
 * 2. Deno.env.ATLAS_DAEMON_URL
 * 3. process.env.ATLAS_DAEMON_URL (Node.js)
 * 4. globalThis.ATLAS_DAEMON_URL (Tauri)
 * 5. Default: http://127.0.0.1:8080
 */
export function getAtlasDaemonUrl(): string {
  // In web builds (bundled by Vite), use relative URLs (proxied by web-client server)
  if (typeof __TAURI_BUILD__ !== "undefined" && !__TAURI_BUILD__) {
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
