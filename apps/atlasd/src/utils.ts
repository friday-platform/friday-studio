/**
 * Daemon-related utilities for Atlas
 */

import { env } from "node:process";
import { logger } from "@atlas/logger";
import { getAtlasDaemonUrl as getAtlasDaemonUrlBase } from "@atlas/oapi-client";
import { z } from "zod";

/**
 * Get the Atlas daemon URL with validation
 * Reads from FRIDAY_DAEMON_URL environment variable or falls back to default
 *
 * @returns The daemon URL (validated or default if invalid)
 */
export function getAtlasDaemonUrl(): string {
  const url = getAtlasDaemonUrlBase();

  // Validate the URL if it came from environment
  if (env.FRIDAY_DAEMON_URL) {
    try {
      new URL(url);
    } catch {
      logger.warn(
        `Invalid FRIDAY_DAEMON_URL: "${url}". Must be a valid URL (e.g., http://127.0.0.1:8080). Using default.`,
      );
      return "http://127.0.0.1:8080";
    }
  }

  return url;
}

export const errorResponseSchema = z
  .object({ error: z.string() })
  .meta({ description: "Standard error response" });
