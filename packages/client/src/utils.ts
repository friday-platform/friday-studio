/**
 * Utility functions for the Atlas client
 */

import { getAtlasClient } from "./client.ts";
import { getAtlasDaemonUrl } from "@atlas/tools";

/**
 * Check if the Atlas daemon is running and accessible
 */
export async function checkAtlasRunning(): Promise<boolean> {
  const client = getAtlasClient();
  return await client.isHealthy();
}

/**
 * Create a helpful error message when Atlas is not running
 */
export function createAtlasNotRunningError(): Error {
  return new Error(
    `Atlas daemon is not running. Start it with 'atlas daemon start' or ensure it's accessible at ${getAtlasDaemonUrl()}`,
  );
}
