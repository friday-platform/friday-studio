/**
 * App Install State - JWT-based encoding
 * Encodes app install flow state as signed JWT tokens (no PKCE - simpler than OAuth state)
 */

import { sign, verify } from "hono/jwt";
import { z } from "zod";
import { STATE_JWT_SECRET } from "../oauth/jwt-secret.ts";

/**
 * JWT payload for app install flow state
 * Simpler than OAuth state - no PKCE code verifier needed
 */
const AppInstallStateSchema = z.object({
  k: z.literal("app_install"), // Kind discriminator
  p: z.string(), // providerId
  r: z.string().optional(), // redirectUri (post-install destination)
  u: z.string().optional(), // userId
  exp: z.number(), // expiration (10 minutes from creation)
});

export type AppInstallState = z.infer<typeof AppInstallStateSchema>;

/**
 * Encode app install flow state as a signed JWT
 * @param payload Flow state (without k and exp - added automatically)
 * @returns Signed JWT token
 */
export async function encodeAppInstallState(
  payload: Omit<AppInstallState, "k" | "exp">,
): Promise<string> {
  return await sign(
    { k: "app_install", ...payload, exp: Math.floor(Date.now() / 1000) + 600 }, // 10min
    STATE_JWT_SECRET,
  );
}

/**
 * Decode and verify app install flow state JWT
 * @param state Signed JWT token
 * @returns Decoded flow state
 * @throws If signature invalid or token expired
 */
export async function decodeAppInstallState(state: string): Promise<AppInstallState> {
  const payload = await verify(state, STATE_JWT_SECRET, "HS256");
  return AppInstallStateSchema.parse(payload);
}
