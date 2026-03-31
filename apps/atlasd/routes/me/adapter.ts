import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { decodeJwtPayload } from "@atlas/core/credentials";
import { createLogger } from "@atlas/logger";
import { fail, type Result, stringifyError, success } from "@atlas/utils";
import { getAtlasHome } from "@atlas/utils/paths.server";
import { z } from "zod";
import { type UserIdentity, UserIdentitySchema } from "./schemas.ts";

const logger = createLogger({ name: "user-identity" });
const TIMEOUT_MS = 10_000;

// Cached user ID - extracted from ATLAS_KEY, constant for daemon lifetime
let cachedUserId: string | null = null;
let userIdResolved = false;

/**
 * Get user identity from configured source.
 *
 * - Remote (default when PERSONA_URL set): Fetches from persona service
 * - Local (fallback or USER_IDENTITY_ADAPTER=local): Extracts from ATLAS_KEY JWT
 *   and merges any saved profile overrides from profile.json
 */
export async function getCurrentUser(): Promise<Result<UserIdentity | null, string>> {
  const personaUrl = process.env.PERSONA_URL;
  const atlasKey = process.env.ATLAS_KEY;

  // Remote mode: when PERSONA_URL is set (unless forced local)
  if (personaUrl && atlasKey && process.env.USER_IDENTITY_ADAPTER !== "local") {
    return fetchFromPersonaService(personaUrl, atlasKey);
  }

  // Local mode: extract from JWT and merge saved overrides
  const base = extractFromJwt(atlasKey);
  if (!base.ok || !base.data) return base;

  return success(await mergeLocalOverrides(base.data));
}

/**
 * Get just the user ID, cached for efficiency.
 * Use this for analytics where only the ID is needed.
 * Only caches successful results - errors allow retry.
 */
export async function getCurrentUserId(): Promise<string | undefined> {
  if (userIdResolved) {
    return cachedUserId ?? undefined;
  }

  const result = await getCurrentUser();
  if (result.ok) {
    userIdResolved = true;
    cachedUserId = result.data?.id ?? null;
  }
  return result.ok ? (result.data?.id ?? undefined) : undefined;
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
      usage: 0,
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

export interface UpdateProfileFields {
  full_name?: string;
  display_name?: string;
  profile_photo?: string | null;
}

/**
 * Update user profile via configured source.
 *
 * - Remote (PERSONA_URL set): PATCHes persona service
 * - Local (fallback): Updates local JSON file
 */
export function updateCurrentUser(
  fields: UpdateProfileFields,
): Promise<Result<UserIdentity | null, string>> {
  const personaUrl = process.env.PERSONA_URL;
  const atlasKey = process.env.ATLAS_KEY;

  if (personaUrl && atlasKey && process.env.USER_IDENTITY_ADAPTER !== "local") {
    return patchPersonaService(personaUrl, atlasKey, fields);
  }

  return updateLocalProfile(atlasKey, fields);
}

async function patchPersonaService(
  baseUrl: string,
  authToken: string,
  fields: UpdateProfileFields,
): Promise<Result<UserIdentity | null, string>> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const body: Record<string, string | null> = {};
    if (fields.full_name !== undefined) body.full_name = fields.full_name;
    if (fields.display_name !== undefined) body.display_name = fields.display_name;
    if (fields.profile_photo !== undefined) {
      // null -> clear photo (send empty string to persona), string -> set URL
      body.profile_photo = fields.profile_photo ?? "";
    }

    const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/api/me`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${authToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (response.status === 401) {
      await response.text();
      return fail("Authentication failed: invalid ATLAS_KEY");
    }
    if (response.status === 400) {
      const ErrorSchema = z.object({ error: z.string().optional() });
      const errorBody = ErrorSchema.safeParse(await response.json());
      return fail(
        errorBody.success ? (errorBody.data.error ?? "Invalid request") : "Invalid request",
      );
    }
    if (!response.ok) {
      return fail(`HTTP ${response.status}: ${await response.text()}`);
    }

    const parsed = UserIdentitySchema.safeParse(await response.json());
    if (!parsed.success) {
      logger.error("Invalid persona PATCH response", { error: parsed.error.message });
      return fail(`Invalid persona response: ${parsed.error.message}`);
    }

    return success(parsed.data);
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return fail("Request timeout after 10s");
    }
    logger.error("Persona PATCH request failed", { error: stringifyError(error) });
    return fail(`Persona service request failed: ${stringifyError(error)}`);
  } finally {
    clearTimeout(timeoutId);
  }
}

function getLocalProfilePath(): string {
  return join(getAtlasHome(), "profile.json");
}

const LocalProfileSchema = z.record(z.string(), z.unknown());

async function readLocalProfile(): Promise<Record<string, unknown>> {
  try {
    const data = await readFile(getLocalProfilePath(), "utf-8");
    const parsed = LocalProfileSchema.safeParse(JSON.parse(data));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

async function mergeLocalOverrides(base: UserIdentity): Promise<UserIdentity> {
  const overrides = await readLocalProfile();
  return {
    ...base,
    full_name: typeof overrides.full_name === "string" ? overrides.full_name : base.full_name,
    display_name:
      typeof overrides.display_name === "string" ? overrides.display_name : base.display_name,
    profile_photo:
      typeof overrides.profile_photo === "string"
        ? overrides.profile_photo
        : overrides.profile_photo === null
          ? null
          : base.profile_photo,
  };
}

async function updateLocalProfile(
  atlasKey: string | undefined,
  fields: UpdateProfileFields,
): Promise<Result<UserIdentity | null, string>> {
  // Get base identity from JWT
  const base = extractFromJwt(atlasKey);
  if (!base.ok || !base.data) return base;

  // Read existing overrides
  const overrides = await readLocalProfile();

  // Apply new fields
  if (fields.full_name !== undefined) overrides.full_name = fields.full_name;
  if (fields.display_name !== undefined) overrides.display_name = fields.display_name;
  if (fields.profile_photo !== undefined) overrides.profile_photo = fields.profile_photo;

  // Save overrides
  const dir = getAtlasHome();
  await mkdir(dir, { recursive: true });
  await writeFile(getLocalProfilePath(), JSON.stringify(overrides, null, 2));

  return success(await mergeLocalOverrides(base.data));
}
