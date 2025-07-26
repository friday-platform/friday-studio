/**
 * Utilities for OpenAPI client
 */

// Declare process for Node.js compatibility
declare const process: {
  env: Record<string, string | undefined>;
} | undefined;

/**
 * Get the Atlas daemon URL from environment or default
 * Works in both Deno and Node.js environments
 */
export function getAtlasDaemonUrl(): string {
  // Try to get from environment in a cross-platform way
  let daemonUrl: string | undefined;

  // Check if we're in Deno
  if (typeof Deno !== "undefined" && Deno.env) {
    daemonUrl = Deno.env.get("ATLAS_DAEMON_URL");
  } // Check if we're in Node.js
  else if (typeof process !== "undefined" && process.env) {
    daemonUrl = process.env.ATLAS_DAEMON_URL;
  }

  return daemonUrl || "http://localhost:8080";
}
