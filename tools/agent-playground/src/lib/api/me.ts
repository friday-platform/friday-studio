/**
 * Thin client for the daemon's `/api/me` surface.
 *
 * Identity (`GET /me`), profile patch (`PATCH /me`), and onboarding
 * gate (`GET /me/onboarding`, `POST /me/onboarding/complete`). The
 * playground proxies `/api/daemon/*` to the daemon, so all paths are
 * relative to that prefix.
 */

import { z } from "zod";

const PROXY_BASE = "/api/daemon";

export const MeIdentitySchema = z.object({
  id: z.string(),
  full_name: z.string().nullable(),
  email: z.email().nullable(),
  display_name: z.string().nullable(),
  profile_photo: z.string().nullable(),
  timezone: z.string().nullable(),
  locale: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  usage: z.number(),
});

export type MeIdentity = z.infer<typeof MeIdentitySchema>;

const MeResponseSchema = z.object({ user: MeIdentitySchema });

const OnboardingResponseSchema = z.object({
  version: z.number().int().nonnegative(),
  completed: z.boolean(),
  requiredFields: z.array(z.string()),
  missingRequired: z.array(z.string()),
});

export type OnboardingState = z.infer<typeof OnboardingResponseSchema>;

const OnboardingCompleteResponseSchema = z.object({
  version: z.number().int().nonnegative(),
  completed: z.boolean(),
});

export async function getMe(): Promise<MeIdentity> {
  const res = await globalThis.fetch(`${PROXY_BASE}/api/me`);
  if (!res.ok) throw new Error(`GET /api/me failed: ${res.status}`);
  return MeResponseSchema.parse(await res.json()).user;
}

export interface PatchMeFields {
  full_name?: string;
  display_name?: string;
  profile_photo?: string | null;
  email?: string;
  timezone?: string;
  locale?: string;
}

export async function patchMe(fields: PatchMeFields): Promise<MeIdentity> {
  const res = await globalThis.fetch(`${PROXY_BASE}/api/me`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(fields),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? `PATCH /api/me failed: ${res.status}`);
  }
  return MeResponseSchema.parse(await res.json()).user;
}

export async function getOnboardingState(): Promise<OnboardingState> {
  const res = await globalThis.fetch(`${PROXY_BASE}/api/me/onboarding`);
  if (!res.ok) throw new Error(`GET /api/me/onboarding failed: ${res.status}`);
  return OnboardingResponseSchema.parse(await res.json());
}

export async function completeOnboarding(): Promise<{ version: number; completed: boolean }> {
  const res = await globalThis.fetch(`${PROXY_BASE}/api/me/onboarding/complete`, {
    method: "POST",
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? `POST /api/me/onboarding/complete failed: ${res.status}`);
  }
  return OnboardingCompleteResponseSchema.parse(await res.json());
}
