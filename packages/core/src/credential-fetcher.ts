import process from "node:process";
import { logger } from "@atlas/logger";
import { formatDate } from "@atlas/utils";
import { type RetryOptions, retry } from "@std/async/retry";
import { decodeJwt, type JWTPayload } from "jose";
import { z } from "zod";
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

/** Schema for validating Atlas JWT claims */
const AtlasJWTSchema = z.object({ iss: z.literal("tempest-atlas"), exp: z.number() });

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

/**
 * Decode JWT payload without signature verification.
 * Returns undefined on invalid input instead of throwing.
 */
export function decodeJwtPayload(jwt: string): JWTPayload | undefined {
  try {
    return decodeJwt(jwt);
  } catch (error) {
    logger.warn("Failed to decode JWT", { error });
    return undefined;
  }
}

/**
 * Extract tempest_user_id from an Atlas JWT.
 * Returns undefined if the JWT is invalid or missing the claim.
 */
export function extractTempestUserId(atlasKey: string): string | undefined {
  const payload = decodeJwtPayload(atlasKey);
  return (payload?.user_metadata as Record<string, string> | undefined)?.tempest_user_id;
}

export function validateAtlasJWT(token: string): void {
  const payload = decodeJwtPayload(token);
  if (!payload) {
    throwWithCause("Atlas key is invalid. Please ensure you have a valid Atlas API key.", {
      type: "unknown",
      code: "INVALID_JWT_FORMAT",
    });
  }

  const result = AtlasJWTSchema.safeParse(payload);
  if (!result.success) {
    throwWithCause("Atlas key has invalid claims. Expected issuer 'tempest-atlas'.", {
      type: "unknown",
      code: "INVALID_JWT_CLAIMS",
      issues: result.error.issues,
    });
  }

  const now = Math.floor(Date.now() / 1000);
  if (result.data.exp <= now) {
    const expirationDate = new Date(result.data.exp * 1000);
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
      method: "GET",
      headers: { Authorization: `Bearer ${atlasKey}` },
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
export function setToEnv(creds: Credentials): { setCount: number; skippedCount: number } {
  let setCount = 0;
  let skippedCount = 0;
  for (const [key, value] of Object.entries(creds)) {
    if (!process.env[key]) {
      process.env[key] = value;
      setCount++;
    } else {
      skippedCount++;
    }
  }
  return { setCount, skippedCount };
}
