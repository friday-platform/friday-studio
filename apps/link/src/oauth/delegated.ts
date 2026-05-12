/**
 * Delegated OAuth helpers — for flows where code-for-token exchange
 * happens in an external endpoint (e.g. a Cloud Function holding the
 * client_secret) and tokens arrive at the local callback as query
 * params.
 *
 * @module oauth/delegated
 */

import { logger } from "@atlas/logger";
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
      `Delegated callback missing required fields: ${parsed.error.issues
        .map((i) => i.path.join("."))
        .join(", ")}`,
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

const DelegatedRefreshErrorBodySchema = z.object({
  error: z.string(),
  error_description: z.string().optional(),
});

/**
 * Why transient: caller should retry / wait, not prompt re-auth.
 * - `network`:      fetch threw (DNS, ECONNREFUSED, ECONNRESET, TLS, abort that wasn't our timeout)
 * - `timeout`:      our 15s AbortSignal.timeout fired
 * - `http_5xx`:     upstream said it's broken
 * - `http_429`:     upstream said slow down
 * - `platform_bug`: 4xx with non-`invalid_grant` error code, malformed body, or plain-text 4xx —
 *                   refresh_token might still be valid, but the endpoint is misbehaving
 */
export type TransientReason = "network" | "timeout" | "http_5xx" | "http_429" | "platform_bug";

/**
 * Outcome of a refresh attempt against the delegated endpoint.
 *
 * Only `kind: "token_dead"` means the refresh_token is provably revoked
 * (RFC 6749 § 5.2 `invalid_grant`). Callers should branch exhaustively on
 * `kind` rather than reading HTTP responses directly.
 */
export type RefreshOutcome =
  | { kind: "success"; tokens: DelegatedTokens }
  | { kind: "token_dead" }
  | { kind: "transient"; reason: TransientReason; detail: string };

const REFRESH_FETCH_TIMEOUT_MS = 15_000;

async function classifyRefreshAttempt(
  config: Extract<OAuthConfig, { mode: "delegated" }>,
  refreshToken: string,
): Promise<RefreshOutcome> {
  let response: Response;
  try {
    response = await fetch(config.delegatedRefreshUri, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: refreshToken }),
      signal: AbortSignal.timeout(REFRESH_FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    const detail = err instanceof Error ? err.message : String(err);
    if (name === "AbortError" || name === "TimeoutError") {
      return { kind: "transient", reason: "timeout", detail };
    }
    return { kind: "transient", reason: "network", detail };
  }

  if (response.ok) {
    const rawBody = await response.text();
    let json: unknown;
    try {
      json = JSON.parse(rawBody);
    } catch {
      logger.warn("oauth_refresh_platform_bug", {
        reason: "non_json_success_body",
        status: response.status,
        body: rawBody.slice(0, 500),
      });
      return {
        kind: "transient",
        reason: "platform_bug",
        detail: `2xx with non-JSON body: ${rawBody.slice(0, 200)}`,
      };
    }
    const parsed = DelegatedRefreshResponseSchema.safeParse(json);
    if (!parsed.success) {
      logger.warn("oauth_refresh_platform_bug", {
        reason: "malformed_success_body",
        status: response.status,
        zodError: parsed.error.message,
      });
      return {
        kind: "transient",
        reason: "platform_bug",
        detail: `2xx with malformed body: ${parsed.error.message}`,
      };
    }
    return {
      kind: "success",
      tokens: {
        access_token: parsed.data.access_token,
        refresh_token: refreshToken, // preserved — upstream never rotates
        expires_at: Math.floor(parsed.data.expiry_date / 1000),
        scope: parsed.data.scope,
        token_type: parsed.data.token_type ?? "Bearer",
      },
    };
  }

  if (response.status === 429) {
    const body = await response.text().catch(() => "");
    return {
      kind: "transient",
      reason: "http_429",
      detail: `HTTP 429 ${response.statusText} ${body.slice(0, 200)}`,
    };
  }

  if (response.status >= 500) {
    const body = await response.text().catch(() => "");
    return {
      kind: "transient",
      reason: "http_5xx",
      detail: `HTTP ${response.status} ${response.statusText} ${body.slice(0, 200)}`,
    };
  }

  // 4xx (non-429): need to parse body to distinguish invalid_grant vs platform_bug.
  const rawBody = await response.text().catch(() => "");
  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    logger.warn("oauth_refresh_platform_bug", {
      reason: "non_json_4xx_body",
      status: response.status,
      body: rawBody.slice(0, 500),
    });
    return {
      kind: "transient",
      reason: "platform_bug",
      detail: `HTTP ${response.status} with non-JSON body: ${rawBody.slice(0, 200)}`,
    };
  }

  const parsedError = DelegatedRefreshErrorBodySchema.safeParse(json);
  if (!parsedError.success) {
    logger.warn("oauth_refresh_platform_bug", {
      reason: "4xx_missing_error_field",
      status: response.status,
      body: rawBody.slice(0, 500),
    });
    return {
      kind: "transient",
      reason: "platform_bug",
      detail: `HTTP ${response.status} with JSON body missing 'error' field: ${rawBody.slice(
        0,
        200,
      )}`,
    };
  }

  if (parsedError.data.error === "invalid_grant") {
    return { kind: "token_dead" };
  }

  logger.warn("oauth_refresh_platform_bug", {
    reason: "4xx_non_invalid_grant",
    status: response.status,
    errorCode: parsedError.data.error,
    errorDescription: parsedError.data.error_description,
  });
  return {
    kind: "transient",
    reason: "platform_bug",
    detail: `HTTP ${response.status} error=${parsedError.data.error}`,
  };
}

/** Caller context used for log correlation. Both fields are optional. */
export interface RefreshClassifyMeta {
  provider?: string;
  credentialId?: string;
}

/**
 * Refresh an access token via the delegated endpoint, returning a typed
 * outcome rather than throwing. Single attempt — no retry.
 *
 * Trust contract: only `kind === "token_dead"` means the refresh_token
 * is provably no longer usable.
 *
 * Verified against Google's documented response shape
 * (developers.google.com/identity/protocols/oauth2) — when a refresh
 * fails because the token is revoked / expired / never-issued, Google's
 * `https://oauth2.googleapis.com/token` returns:
 *
 *   HTTP 400 Bad Request
 *   { "error": "invalid_grant",
 *     "error_description": "Token has been expired or revoked." }
 *
 * Per RFC 6749 § 5.2, `invalid_grant` means the refresh_token is
 * "invalid, expired, revoked, does not match the redirect URI, or was
 * issued to another client".
 *
 * The upstream Cloud Function
 * (github.com/gemini-cli-extensions/workspace/cloud_function/index.js)
 * forwards Google's status + body verbatim at line 328-337; its success
 * response at line 321-326 deliberately omits `refresh_token` because
 * Google never rotates it on refresh. So the bytes we see here are
 * Google's bytes.
 *
 * Everything else is either usable (`success`) or a non-actionable
 * platform/transport failure (`transient`).
 */
export async function refreshDelegatedTokenClassified(
  config: Extract<OAuthConfig, { mode: "delegated" }>,
  refreshToken: string,
  meta: RefreshClassifyMeta = {},
): Promise<RefreshOutcome> {
  const provider = meta.provider ?? "unknown";
  const startedAt = Date.now();
  const outcome = await classifyRefreshAttempt(config, refreshToken);
  const reason = outcome.kind === "transient" ? outcome.reason : undefined;
  logger.info("oauth.refresh.outcome", {
    ...(meta.credentialId !== undefined ? { credentialId: meta.credentialId } : {}),
    provider,
    outcome: { kind: outcome.kind, ...(reason !== undefined ? { reason } : {}) },
    latency_ms: Date.now() - startedAt,
  });
  return outcome;
}

/**
 * Refresh an access token via the delegated refresh endpoint.
 *
 * The endpoint expects `POST {refresh_token}` JSON and returns the new
 * access token. Note: the refresh response does NOT include a fresh
 * `refresh_token` — Google never returns one on refresh, so the caller
 * must preserve the original.
 *
 * Throws on `token_dead` and on `transient`. Callers wanting to
 * distinguish those cases should use `refreshDelegatedTokenClassified`
 * directly.
 */
export async function refreshDelegatedToken(
  config: Extract<OAuthConfig, { mode: "delegated" }>,
  refreshToken: string,
  meta: RefreshClassifyMeta = {},
): Promise<DelegatedTokens> {
  const outcome = await refreshDelegatedTokenClassified(config, refreshToken, meta);
  switch (outcome.kind) {
    case "success":
      return outcome.tokens;
    case "token_dead":
      throw new Error(`Delegated refresh failed: token_dead`);
    case "transient":
      throw new Error(
        `Delegated refresh failed: transient reason=${outcome.reason} detail=${outcome.detail}`,
      );
  }
}
