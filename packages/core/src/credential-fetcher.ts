import { logger } from "@atlas/logger";
import { z } from "zod/v4";
import { getCredentialsApiUrl } from "./atlas-config.ts";

// JWT payload schema
const JWTPayloadSchema = z.object({
  email: z.string(),
  iss: z.literal("tempest-atlas"),
  sub: z.string(),
  exp: z.number(),
  iat: z.number(),
});

// API response schema
const CredentialsResponseSchema = z.object({
  credentials: z.record(z.string(), z.string()),
  expires_at: z.string().optional(),
});

export interface FetchCredentialsOptions {
  atlasKey: string;
  apiUrl?: string;
  retries?: number;
  retryDelay?: number;
}

export interface Credentials {
  [key: string]: string;
}

export class CredentialFetcher {
  private static readonly DEFAULT_RETRIES = 3;
  private static readonly DEFAULT_RETRY_DELAY = 1000; // 1 second

  /**
   * Validates a JWT token format and expiration
   */
  static validateJWT(token: string): { valid: boolean; error?: string } {
    try {
      // Check JWT format (three parts)
      const parts = token.split(".");
      if (parts.length !== 3) {
        return { valid: false, error: "Invalid JWT format - must have three parts" };
      }

      // Decode and validate payload
      const payload = JSON.parse(atob(parts[1]!));
      const validatedPayload = JWTPayloadSchema.parse(payload);

      // Check expiration
      const now = Math.floor(Date.now() / 1000);
      if (validatedPayload.exp <= now) {
        return { valid: false, error: "Atlas key has expired" };
      }

      return { valid: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return { valid: false, error: `Invalid Atlas key: ${errorMessage}` };
    }
  }

  /**
   * Fetches credentials from the Atlas API using an Atlas key
   */
  static async fetchCredentials(options: FetchCredentialsOptions): Promise<Credentials> {
    const {
      atlasKey,
      apiUrl = getCredentialsApiUrl(),
      retries = CredentialFetcher.DEFAULT_RETRIES,
      retryDelay = CredentialFetcher.DEFAULT_RETRY_DELAY,
    } = options;

    // Validate JWT before making request
    const validation = CredentialFetcher.validateJWT(atlasKey);
    if (!validation.valid) {
      throw new Error(validation.error);
    }

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const response = await fetch(apiUrl, {
          method: "POST",
          headers: { Authorization: `Bearer ${atlasKey}`, "Content-Type": "application/json" },
          signal: AbortSignal.timeout(30000), // 30 second timeout
        });

        if (!response.ok) {
          const errorMessage = CredentialFetcher.getErrorMessage(response);
          throw new Error(errorMessage);
        }

        const data = await response.json();
        const validated = CredentialsResponseSchema.parse(data);

        // Log expiration if provided
        if (validated.expires_at) {
          logger.info(`Credentials expire at: ${validated.expires_at}`);
        }

        return validated.credentials;
      } catch (error) {
        lastError = error as Error;

        // Don't retry on client errors (4xx)
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (
          errorMessage.includes("401") ||
          errorMessage.includes("403") ||
          errorMessage.includes("404") ||
          errorMessage.includes("Invalid")
        ) {
          throw error;
        }

        // Retry on network or server errors
        if (attempt < retries) {
          logger.warn(
            `Credential fetch attempt ${attempt + 1} failed, retrying in ${retryDelay}ms...`,
          );
          await new Promise((resolve) => setTimeout(resolve, retryDelay * (attempt + 1)));
        }
      }
    }

    throw new Error(`Failed to fetch credentials after ${retries} retries: ${lastError?.message}`);
  }

  /**
   * Gets a user-friendly error message based on HTTP status
   */
  private static getErrorMessage(response: Response): string {
    const status = response.status;
    const statusText = response.statusText;

    switch (status) {
      case 401:
        return "Invalid or expired Atlas key";
      case 403:
        return "Access denied - please check your Atlas key permissions";
      case 404:
        return "Credentials endpoint not found - please check your Atlas configuration";
      case 429:
        return "Too many requests - please try again later";
      case 500:
      case 502:
      case 503:
        return "Atlas service temporarily unavailable - please try again later";
      default:
        return `Failed to fetch credentials: ${status} ${statusText}`;
    }
  }
}
