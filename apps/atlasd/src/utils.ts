/**
 * Daemon-related utilities for Atlas
 */

import { logger } from "@atlas/logger";
import { z } from "zod";

// Private constants
const DEFAULT_DAEMON_URL = "http://127.0.0.1:8080";

/**
 * Validates that a string is a valid URL
 */
function isValidUrl(urlString: string): boolean {
  try {
    new URL(urlString);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the Atlas daemon URL
 * Reads from ATLAS_DAEMON_URL environment variable or falls back to default
 *
 * @returns The daemon URL (validated or default if invalid)
 */
export function getAtlasDaemonUrl(): string {
  const envUrl = Deno.env.get("ATLAS_DAEMON_URL");

  if (envUrl) {
    // Validate the URL from environment
    if (!isValidUrl(envUrl)) {
      logger.warn(
        `Invalid ATLAS_DAEMON_URL: "${envUrl}". Must be a valid URL (e.g., http://127.0.0.1:8080). Using default.`,
      );
      return DEFAULT_DAEMON_URL;
    }
    return envUrl;
  }

  return DEFAULT_DAEMON_URL;
}

export const errorResponseSchema = z
  .object({ error: z.string() })
  .meta({ description: "Standard error response" });
