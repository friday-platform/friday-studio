/**
 * OAuth Flow State - JWT-based encoding
 * Encodes flow state as signed JWT tokens, eliminating need for server-side storage
 */

import { sign, verify } from "hono/jwt";
import { z } from "zod";
import { STATE_JWT_SECRET } from "./jwt-secret.ts";

/**
 * JWT payload for OAuth flow state
 * Encodes minimal data needed to complete the flow
 */
const StatePayloadSchema = z.object({
  v: z.string(), // codeVerifier
  p: z.string(), // providerId
  c: z.string(), // callbackUrl (OAuth redirect_uri where provider sends auth code)
  r: z.string().optional(), // redirectUri (where to send user after auth)
  u: z.string().optional(), // userId
  i: z.string().optional(), // client_id (for discovery mode flows)
  exp: z.number(), // expiration (10 minutes from creation)
});

export type StatePayload = z.infer<typeof StatePayloadSchema>;

/**
 * Encode OAuth flow state as a signed JWT
 * @param payload Flow state (without exp)
 * @returns Signed JWT token
 */
export async function encodeState(payload: Omit<StatePayload, "exp">): Promise<string> {
  return await sign(
    { ...payload, exp: Math.floor(Date.now() / 1000) + 600 }, // 10min
    STATE_JWT_SECRET,
  );
}

/**
 * Decode and verify OAuth flow state JWT
 * @param state Signed JWT token
 * @returns Decoded flow state
 * @throws If signature invalid or token expired
 */
export async function decodeState(state: string): Promise<StatePayload> {
  const payload = await verify(state, STATE_JWT_SECRET, "HS256");
  return StatePayloadSchema.parse(payload);
}
