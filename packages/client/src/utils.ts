/**
 * Utility functions for the Atlas client
 */

import { getAtlasDaemonUrl } from "@atlas/atlasd";

/**
 * Create a helpful error message when Atlas is not running
 */
export function createAtlasNotRunningError(): Error {
  return new Error(
    `Atlas daemon is not running. Start it with 'atlas daemon start' or ensure it's accessible at ${getAtlasDaemonUrl()}`,
  );
}
