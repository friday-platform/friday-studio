/**
 * Configuration validation utilities for Atlas
 */

import { z } from "zod/v4";

/**
 * Custom error class for configuration validation errors
 */
export class ConfigValidationError extends Error {
  constructor(
    message: string,
    public file: string,
    public field?: string,
    public value?: unknown,
  ) {
    super(message);
    this.name = "ConfigValidationError";
  }
}

/**
 * Format Zod validation errors into a user-friendly message
 */
export function formatZodError(error: z.ZodError, filename: string): string {
  const issues = error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "root";
    let message = `  • ${path}: ${issue.message}`;

    // Add received value for certain issue types
    if ("received" in issue && issue.received !== undefined) {
      message += ` (received: ${issue.received})`;
    }

    return message;
  });

  return `Configuration validation failed in ${filename}:\n${
    issues.join("\n")
  }\n\nPlease check your configuration file and ensure all required fields are present and valid.`;
}
