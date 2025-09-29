import { logger } from "@atlas/logger";
import { formatDate } from "@atlas/utils";
import { retry, type RetryOptions } from "@std/async/retry";
import { z } from "zod/v4";
import { getCredentialsApiUrl } from "./atlas-config.ts";
import { throwWithCause } from "./errors.ts";

/**
 * Fetches bundled API credentials from Atlas for Friends & Family users.
 *
 * During F&F phase, Atlas provides API keys for various services so users
 * don't need their own. Credentials are returned as a record mapping
 * environment variable names to their values.
 *
 * Example response:
 * {
 *   "OPENAI_API_KEY": "sk-...",
 *   "GITHUB_TOKEN": "ghp_..."
 * }
 */

const DEFAULT_RETRIES = 3;
const DEFAULT_RETRY_DELAY = 1000;

const JWTPayloadSchema = z.object({
  email: z.string(),
  iss: z.literal("tempest-atlas"),
  sub: z.string(),
  exp: z.number(),
  iat: z.number(),
});

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

export type Credentials = Record<string, string>;

export function validateAtlasJWT(token: string): void {
  const parts = token.split(".");
  const encodedPayload = parts.at(1);
  if (parts.length !== 3 || !encodedPayload) {
    throwWithCause("Atlas key is invalid. Please ensure you have a valid Atlas API key.", {
      type: "unknown",
      code: "INVALID_JWT_FORMAT",
    });
  }

  const payload = JSON.parse(atob(encodedPayload));
  const jwtPayload = JWTPayloadSchema.parse(payload);

  const now = Math.floor(Date.now() / 1000);
  if (jwtPayload.exp <= now) {
    const expirationDate = new Date(jwtPayload.exp * 1000);
    throwWithCause(
      "Atlas key has expired. Please generate a new key from your Atlas dashboard.",
      new Error(`Key expired on ${formatDate(expirationDate)}`),
    );
  }
}

/**
 * Fetches credentials from Atlas API with automatic retry for transient failures.
 * Validates the Atlas JWT before making the request.
 */
export async function fetchCredentials(options: FetchCredentialsOptions): Promise<Credentials> {
  const {
    atlasKey,
    apiUrl = getCredentialsApiUrl(),
    retries = DEFAULT_RETRIES,
    retryDelay = DEFAULT_RETRY_DELAY,
  } = options;

  validateAtlasJWT(atlasKey);

  const retryOptions: RetryOptions = {
    maxAttempts: retries + 1,
    multiplier: 2, // Use exponential backoff
    minTimeout: retryDelay,
    maxTimeout: retryDelay * 10,
  };

  return await retry(async () => {
    const response = await fetch(apiUrl, {
      method: "POST",
      headers: { Authorization: `Bearer ${atlasKey}`, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      const error = new Error(`${response.status} ${response.statusText}`);

      // 4xx errors should not be retried - these are client errors
      if (response.status >= 400 && response.status < 500) {
        if (response.status === 401 || response.status === 403) {
          throwWithCause("Authentication failed. Please check your Atlas API key.", error);
        }
        // All other 4xx errors - don't retry
        throwWithCause(`Request failed: ${response.statusText}`, error);
      }

      // 5xx errors will be retried automatically by @std/async
      throw error;
    }

    const data = await response.json();
    const credentialsResponse = CredentialsResponseSchema.parse(data);

    if (credentialsResponse.expires_at) {
      logger.info(`Credentials expire at: ${credentialsResponse.expires_at}`);
    }

    return credentialsResponse.credentials;
  }, retryOptions);
}

/**
 * Sets credentials to Deno environment variables.
 */
export function setToDenoEnv(creds: Credentials): { setCount: number; skippedCount: number } {
  let setCount = 0;
  let skippedCount = 0;
  for (const [key, value] of Object.entries(creds)) {
    if (!Deno.env.get(key)) {
      Deno.env.set(key, value);
      setCount++;
    } else {
      skippedCount++;
    }
  }
  return { setCount, skippedCount };
}
