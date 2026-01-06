import process from "node:process";
import { decodeJwtPayload } from "@atlas/core/credentials";
import { createLogger } from "@atlas/logger";
import { fail, type Result, stringifyError, success } from "@atlas/utils";
import { type UserIdentity, UserIdentitySchema } from "./schemas.ts";

const logger = createLogger({ name: "user-identity" });
const TIMEOUT_MS = 10_000;

/**
 * Get user identity from configured source.
 *
 * - Remote (default when PERSONA_URL set): Fetches from persona service
 * - Local (fallback or USER_IDENTITY_ADAPTER=local): Extracts from ATLAS_KEY JWT
 */
export function getCurrentUser(): Promise<Result<UserIdentity | null, string>> {
  const personaUrl = process.env.PERSONA_URL;
  const atlasKey = process.env.ATLAS_KEY;

  // Remote mode: when PERSONA_URL is set (unless forced local)
  if (personaUrl && atlasKey && process.env.USER_IDENTITY_ADAPTER !== "local") {
    return fetchFromPersonaService(personaUrl, atlasKey);
  }

  // Local mode: extract from JWT
  return Promise.resolve(extractFromJwt(atlasKey));
}

function extractFromJwt(atlasKey: string | undefined): Result<UserIdentity | null, string> {
  if (!atlasKey) return success(null);

  try {
    const payload = decodeJwtPayload(atlasKey) as
      | { email?: string; sub?: string; user_metadata?: { tempest_user_id?: string } }
      | undefined;
    if (!payload?.email) return success(null);

    const name = payload.email.split("@")[0] ?? "unknown";
    const now = new Date().toISOString();

    return success({
      id: payload.user_metadata?.tempest_user_id ?? payload.sub ?? name,
      full_name: name,
      email: payload.email,
      created_at: now,
      updated_at: now,
      display_name: name,
      profile_photo: null,
    });
  } catch (error) {
    logger.error("Failed to decode ATLAS_KEY JWT", { error: stringifyError(error) });
    return fail(`Failed to decode JWT: ${stringifyError(error)}`);
  }
}

async function fetchFromPersonaService(
  baseUrl: string,
  authToken: string,
): Promise<Result<UserIdentity | null, string>> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/api/me`, {
      headers: { Authorization: `Bearer ${authToken}` },
      signal: controller.signal,
    });

    if (response.status === 401) {
      await response.text();
      return fail("Authentication failed: invalid ATLAS_KEY");
    }
    if (response.status === 503) {
      await response.text();
      return fail("Persona service unavailable");
    }
    if (response.status === 404) {
      await response.text();
      return success(null);
    }
    if (!response.ok) {
      return fail(`HTTP ${response.status}: ${await response.text()}`);
    }

    const parsed = UserIdentitySchema.safeParse(await response.json());
    if (!parsed.success) {
      logger.error("Invalid persona response", { error: parsed.error.message });
      return fail(`Invalid persona response: ${parsed.error.message}`);
    }

    return success(parsed.data);
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return fail("Request timeout after 10s");
    }
    logger.error("Persona service request failed", { error: stringifyError(error) });
    return fail(`Persona service request failed: ${stringifyError(error)}`);
  } finally {
    clearTimeout(timeoutId);
  }
}
