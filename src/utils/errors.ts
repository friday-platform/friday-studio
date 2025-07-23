/**
 * Custom error classes for improved error handling
 */

import { z } from "zod/v4";

/**
 * Custom error class for validation failures using Zod
 * Provides better error context and wraps ZodError with application-specific context
 */
export class ValidationError extends Error {
  constructor(message: string, zodError: z.ZodError) {
    // The default ZodError message is already quite readable and includes details.
    super(`${message}\n${zodError.message}`);
    this.name = "ValidationError";
    this.cause = zodError;
  }
}
