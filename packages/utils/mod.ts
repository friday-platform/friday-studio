import { z } from "zod/v4";

/**
 * @atlas/utils - Shared utility functions for Atlas
 */

export { getAtlasHome, getAtlasMemoryDir, getMECMFCacheDir, isSystemService } from "./src/paths.ts";

/**
 * Converts an error to a human-readable string.
 */
export function stringifyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Helper function for formatting Zod errors
 */
export function formatZodError(error: z.ZodError): string {
  return z.prettifyError(error);
}
