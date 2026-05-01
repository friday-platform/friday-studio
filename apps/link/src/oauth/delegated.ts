/**
 * Delegated OAuth helpers — for flows where code-for-token exchange
 * happens in an external endpoint (e.g. a Cloud Function holding the
 * client_secret) and tokens arrive at the local callback as query
 * params.
 *
 * @module oauth/delegated
 */

import { z } from "zod";
import type { OAuthConfig } from "../providers/types.ts";

/**
 * Tokens parsed from the delegated callback's query params.
 *
 * Shape mirrors what the upstream Cloud Function appends to the redirect
 * URL after a successful code exchange:
 * - `access_token`, `refresh_token`, `scope`, `token_type`
 * - `expiry_date` as absolute epoch milliseconds (NOT seconds, NOT
 *   relative `expires_in`).
 */
const DelegatedCallbackQuerySchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expiry_date: z.coerce.number().int().positive(),
  scope: z.string().optional(),
  token_type: z.string().optional(),
  state: z.string().min(1),
});

export interface DelegatedTokens {
  access_token: string;
  refresh_token?: string;
  /** Unix epoch SECONDS — converted from the upstream `expiry_date` (ms). */
  expires_at: number;
  scope?: string;
  token_type: string;
}

/**
 * Build the authorization URL for a delegated OAuth flow.
 *
 * The `redirect_uri` parameter sent to the authorization server is the
 * delegated exchange endpoint, NOT the local callback. The exchange
 * endpoint receives the `code`, swaps it for tokens, and forwards the
 * user back to the URL embedded in the `state` payload.
 *
 * @param config - Delegated mode OAuth configuration
 * @param csrfToken - Opaque value the exchange endpoint will echo back as `?state=<csrfToken>` on the final redirect. Used to verify the callback originated from our flow.
 * @param finalRedirectUri - The local URL (must be localhost / 127.0.0.1) that the exchange endpoint will redirect to with tokens.
 * @param scopes - Scopes to request, falls back to `config.scopes`.
 */
export function buildDelegatedAuthUrl(
  config: Extract<OAuthConfig, { mode: "delegated" }>,
  csrfToken: string,
  finalRedirectUri: string,
  scopes?: string[],
): string {
  const url = new URL(config.authorizationEndpoint);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.delegatedExchangeUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", config.encodeState({ csrfToken, finalRedirectUri }));

  const scopesToUse = scopes?.length ? scopes : config.scopes;
  if (scopesToUse?.length) {
    url.searchParams.set("scope", scopesToUse.join(" "));
  }

  if (config.extraAuthParams) {
    for (const [key, value] of Object.entries(config.extraAuthParams)) {
      url.searchParams.set(key, value);
    }
  }

  return url.toString();
}

/**
 * Parse pre-exchanged tokens from the delegated callback's query params.
 *
 * @param rawQuery - Raw query params from the callback request.
 * @param expectedCsrf - The CSRF value that was passed into `buildDelegatedAuthUrl`. Compared against the bare `?state` query param (NOT base64-decoded — the exchange endpoint forwards the CSRF as a plain string).
 * @throws If query params are missing required tokens or the state does not match the expected CSRF.
 */
export function parseDelegatedCallback(
  rawQuery: Record<string, string>,
  expectedCsrf: string,
): DelegatedTokens {
  const parsed = DelegatedCallbackQuerySchema.safeParse(rawQuery);
  if (!parsed.success) {
    throw new Error(
      `Delegated callback missing required fields: ${parsed.error.issues.map((i) => i.path.join(".")).join(", ")}`,
    );
  }

  if (parsed.data.state !== expectedCsrf) {
    throw new Error("Delegated callback state mismatch — possible CSRF");
  }

  return {
    access_token: parsed.data.access_token,
    refresh_token: parsed.data.refresh_token,
    // Upstream sends `expiry_date` in epoch ms; Friday stores `expires_at` in seconds.
    expires_at: Math.floor(parsed.data.expiry_date / 1000),
    scope: parsed.data.scope,
    token_type: parsed.data.token_type ?? "Bearer",
  };
}

const DelegatedRefreshResponseSchema = z.object({
  access_token: z.string().min(1),
  expiry_date: z.coerce.number().int().positive(),
  scope: z.string().optional(),
  token_type: z.string().optional(),
});

/**
 * Refresh an access token via the delegated refresh endpoint.
 *
 * The endpoint expects `POST {refresh_token}` JSON and returns the new
 * access token. Note: the refresh response does NOT include a fresh
 * `refresh_token` — Google never returns one on refresh, so the caller
 * must preserve the original.
 */
export async function refreshDelegatedToken(
  config: Extract<OAuthConfig, { mode: "delegated" }>,
  refreshToken: string,
): Promise<DelegatedTokens> {
  const response = await fetch(config.delegatedRefreshUri, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: refreshToken }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Delegated refresh failed: ${response.status} ${response.statusText} ${body}`);
  }

  const body = await response.json();
  const parsed = DelegatedRefreshResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new Error(`Delegated refresh returned malformed response: ${parsed.error.message}`);
  }

  return {
    access_token: parsed.data.access_token,
    refresh_token: refreshToken, // preserved — upstream never rotates
    expires_at: Math.floor(parsed.data.expiry_date / 1000),
    scope: parsed.data.scope,
    token_type: parsed.data.token_type ?? "Bearer",
  };
}
