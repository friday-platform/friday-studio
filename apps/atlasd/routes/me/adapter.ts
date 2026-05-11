import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { UserStorage } from "@atlas/core/users/storage";
import { createLogger } from "@atlas/logger";
import { fail, type Result, stringifyError, success } from "@atlas/utils";
import { getFridayHome } from "@atlas/utils/paths.server";
import { z } from "zod";
import { type UserIdentity, UserIdentitySchema } from "./schemas.ts";

const logger = createLogger({ name: "user-identity" });
const TIMEOUT_MS = 10_000;

/**
 * Get user identity for the request's user.
 *
 * - Remote (PERSONA_URL set): Fetches from persona service. FRIDAY_KEY
 *   is used as the daemon-to-persona Bearer credential — that's an
 *   outbound-auth concern, not an identity-bearing one.
 * - Local: Reads the canonical `UserStorage` record for the given
 *   userId (set by the session middleware) and merges any local
 *   profile.json overrides on top. No JWT decode anywhere.
 */
export function getCurrentUser(
  userId: string | undefined,
): Promise<Result<UserIdentity | null, string>> {
  const personaUrl = process.env.PERSONA_URL;
  const atlasKey = process.env.FRIDAY_KEY;

  if (personaUrl && atlasKey && process.env.USER_IDENTITY_ADAPTER !== "local") {
    return fetchFromPersonaService(personaUrl, atlasKey);
  }

  if (!userId) return Promise.resolve(success(null));
  return buildLocalIdentity(userId);
}

async function buildLocalIdentity(userId: string): Promise<Result<UserIdentity | null, string>> {
  const stored = await UserStorage.getUser(userId);
  if (!stored.ok) return fail(stored.error);

  const now = new Date().toISOString();
  // Bare-bones identity for users that exist in SESSIONS but haven't
  // populated `UserStorage` yet (the page-driven onboarding flow lands
  // their profile fields). `email`/`full_name` schema fields require
  // non-empty strings, so fall back to a deterministic placeholder
  // until the user fills them in.
  const record = stored.data;
  const identity = record?.identity ?? { nameStatus: "unknown" as const };
  const name = identity.name ?? userId;
  const email = identity.email ?? `${userId}@local.friday`;

  const base: UserIdentity = {
    id: userId,
    full_name: name,
    email,
    created_at: record?.createdAt ?? now,
    updated_at: record?.updatedAt ?? now,
    display_name: name,
    profile_photo: null,
    usage: 0,
  };
  return success(await mergeLocalOverrides(base));
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
      return fail("Authentication failed: invalid FRIDAY_KEY");
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
 * Update user profile.
 *
 * - Remote (PERSONA_URL set): PATCHes persona service.
 * - Local: writes to ~/.atlas/profile.json overrides and returns the
 *   merged identity.
 */
export function updateCurrentUser(
  userId: string | undefined,
  fields: UpdateProfileFields,
): Promise<Result<UserIdentity | null, string>> {
  const personaUrl = process.env.PERSONA_URL;
  const atlasKey = process.env.FRIDAY_KEY;

  if (personaUrl && atlasKey && process.env.USER_IDENTITY_ADAPTER !== "local") {
    return patchPersonaService(personaUrl, atlasKey, fields);
  }

  return updateLocalProfile(userId, fields);
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
      return fail("Authentication failed: invalid FRIDAY_KEY");
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
  return join(getFridayHome(), "profile.json");
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
  userId: string | undefined,
  fields: UpdateProfileFields,
): Promise<Result<UserIdentity | null, string>> {
  if (!userId) return success(null);

  const overrides = await readLocalProfile();
  if (fields.full_name !== undefined) overrides.full_name = fields.full_name;
  if (fields.display_name !== undefined) overrides.display_name = fields.display_name;
  if (fields.profile_photo !== undefined) overrides.profile_photo = fields.profile_photo;

  const dir = getFridayHome();
  await mkdir(dir, { recursive: true });
  await writeFile(getLocalProfilePath(), JSON.stringify(overrides, null, 2));

  return buildLocalIdentity(userId);
}
