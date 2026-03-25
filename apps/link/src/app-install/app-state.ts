/** JWT-based state encoding for app install OAuth flows (no PKCE). */

import { sign, verify } from "hono/jwt";
import { z } from "zod";
import { STATE_JWT_SECRET } from "../oauth/jwt-secret.ts";

const AppInstallStateSchema = z.object({
  k: z.literal("app_install"), // Kind discriminator
  p: z.string(), // providerId
  r: z.string().optional(), // redirectUri (post-install destination)
  u: z.string().optional(), // userId
  c: z.string().optional(), // credentialId (for dynamic credential lookup)
  exp: z.number(), // expiration (10 minutes from creation)
});

export type AppInstallState = z.infer<typeof AppInstallStateSchema>;

/** Encode app install flow state as a signed JWT (10-minute expiry). */
export async function encodeAppInstallState(
  payload: Omit<AppInstallState, "k" | "exp">,
): Promise<string> {
  return await sign(
    { k: "app_install", ...payload, exp: Math.floor(Date.now() / 1000) + 600 }, // 10min
    STATE_JWT_SECRET,
  );
}

/** Decode and verify app install flow state JWT. Throws if invalid or expired. */
export async function decodeAppInstallState(state: string): Promise<AppInstallState> {
  const payload = await verify(state, STATE_JWT_SECRET, "HS256");
  return AppInstallStateSchema.parse(payload);
}
