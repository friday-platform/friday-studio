import { nanoid } from "nanoid";

/**
 * Generate a unique ID for a new credential.
 * Uses nanoid for URL-safe, filesystem-safe IDs.
 */
export function generateId(): string {
  return nanoid();
}
