/**
 * Get the Atlas daemon URL from environment or default
 * Works in browser/Tauri environment
 */
export function getAtlasDaemonUrl(): string {
  // In Tauri/browser environment, we can't access Deno.env
  // Check if we have a global config or use default
  // @ts-expect-error - globalThis.ATLAS_DAEMON_URL might be set by Tauri
  const daemonUrl = globalThis.ATLAS_DAEMON_URL;

  // Default to 127.0.0.1:8080 for local development (avoids CORS issues)
  return daemonUrl || "http://127.0.0.1:8080";
}
