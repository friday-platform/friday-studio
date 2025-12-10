/**
 * OAuth Flow State - JWT-based encoding
 * Encodes flow state as signed JWT tokens, eliminating need for server-side storage
 */

import { readFileSync } from "node:fs";
import process from "node:process";
import { sign, verify } from "hono/jwt";
import { z } from "zod";

// Load secret at module initialization - use file if configured, otherwise ephemeral for dev
const secretFile = process.env.LINK_STATE_SIGNING_KEY_FILE;
const SECRET = secretFile ? readFileSync(secretFile, "utf-8").trim() : crypto.randomUUID();

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
    SECRET,
  );
}

/**
 * Decode and verify OAuth flow state JWT
 * @param state Signed JWT token
 * @returns Decoded flow state
 * @throws If signature invalid or token expired
 */
export async function decodeState(state: string): Promise<StatePayload> {
  const payload = await verify(state, SECRET);
  return StatePayloadSchema.parse(payload);
}
