import { logger } from "@atlas/logger";
import { z } from "zod/v4";
import { getCredentialsApiUrl } from "./atlas-config.ts";

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
    throw new Error("Invalid JWT format");
  }

  const payload = JSON.parse(atob(encodedPayload));
  const jwtPayload = JWTPayloadSchema.parse(payload);

  const now = Math.floor(Date.now() / 1000);
  if (jwtPayload.exp <= now) {
    throw new Error("Atlas key has expired");
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

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetch(apiUrl, {
        method: "POST",
        headers: { Authorization: `Bearer ${atlasKey}`, "Content-Type": "application/json" },
        signal: AbortSignal.timeout(30000),
      });

      if (!response.ok) {
        throw new Error(`Credential fetch failed: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      const credentialsResponse = CredentialsResponseSchema.parse(data);

      if (credentialsResponse.expires_at) {
        logger.info(`Credentials expire at: ${credentialsResponse.expires_at}`);
      }

      return credentialsResponse.credentials;
    } catch (error) {
      const isNonRetryable =
        error instanceof Error &&
        (error.message.match(/\b4\d{2}\b/) || // Match 4xx status codes
          error.message.includes("Invalid") ||
          error.message.includes("expired") ||
          error.name === "ZodError");

      if (attempt === retries || isNonRetryable) {
        throw error;
      }

      const backoffMs = retryDelay * (attempt + 1);
      logger.warn(`Attempt ${attempt + 1} failed, retrying in ${backoffMs}ms`);
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
  }

  throw new Error("Unexpected retry loop exit");
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
