/**
 * Eval A — Classifier preserves the refresh_token on transient.
 *
 * Drives `refreshDelegatedTokenClassified` against a mocked `fetch` for
 * the full failure matrix and asserts:
 *   - Only `4xx invalid_grant` returns `kind: "token_dead"`.
 *   - 5xx, 429, network, timeout, and 4xx with other errors return
 *     `kind: "transient"`.
 *   - 2xx with a valid body returns `kind: "success"` AND the original
 *     `refresh_token` is preserved on the returned tokens (the
 *     delegated Cloud Function never rotates it).
 *
 * The classifier is the gatekeeper between "credential is dead, ask
 * user to reconnect" and "credential is fine, server is having a
 * moment" — getting this wrong is what would invalidate
 * still-valid refresh_tokens.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { refreshDelegatedTokenClassified } from "../../../apps/link/src/oauth/delegated.ts";
import type { OAuthConfig } from "../../../apps/link/src/providers/types.ts";

const config: Extract<OAuthConfig, { mode: "delegated" }> = {
  mode: "delegated",
  authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
  delegatedExchangeUri: "https://example.test/exchange",
  delegatedRefreshUri: "https://example.test/refreshToken",
  clientId: "test-client-id",
  scopes: ["openid", "email"],
  extraAuthParams: { access_type: "offline" },
  encodeState: ({ csrfToken, finalRedirectUri }) =>
    btoa(JSON.stringify({ uri: finalRedirectUri, manual: false, csrf: csrfToken })),
};

const SEED_REFRESH_TOKEN = "rt-original-must-survive";

describe("oauth-refresh eval A — classifier outcomes", () => {
  afterEach(() => vi.restoreAllMocks());

  it("4xx invalid_grant → token_dead (the ONLY revocation signal)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "invalid_grant" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const outcome = await refreshDelegatedTokenClassified(config, SEED_REFRESH_TOKEN);
    expect(outcome.kind).toBe("token_dead");
  });

  it("HTTP 500 → transient (server is broken, refresh_token still valid)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("upstream is on fire", { status: 500 }),
    );
    const outcome = await refreshDelegatedTokenClassified(config, SEED_REFRESH_TOKEN);
    expect(outcome.kind).toBe("transient");
    if (outcome.kind === "transient") {
      expect(outcome.reason).toBe("http_5xx");
    }
  });

  it("HTTP 429 → transient (rate-limited, refresh_token still valid)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("slow down", { status: 429 }));
    const outcome = await refreshDelegatedTokenClassified(config, SEED_REFRESH_TOKEN);
    expect(outcome.kind).toBe("transient");
    if (outcome.kind === "transient") {
      expect(outcome.reason).toBe("http_429");
    }
  });

  it("Network failure → transient (refresh_token still valid)", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      Object.assign(new Error("ECONNREFUSED"), { name: "TypeError" }),
    );
    const outcome = await refreshDelegatedTokenClassified(config, SEED_REFRESH_TOKEN);
    expect(outcome.kind).toBe("transient");
    if (outcome.kind === "transient") {
      expect(outcome.reason).toBe("network");
    }
  });

  it("Timeout → transient (refresh_token still valid)", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      Object.assign(new Error("aborted"), { name: "TimeoutError" }),
    );
    const outcome = await refreshDelegatedTokenClassified(config, SEED_REFRESH_TOKEN);
    expect(outcome.kind).toBe("transient");
    if (outcome.kind === "transient") {
      expect(outcome.reason).toBe("timeout");
    }
  });

  it("4xx with non-invalid_grant error → transient platform_bug (NOT token_dead)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "invalid_client" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const outcome = await refreshDelegatedTokenClassified(config, SEED_REFRESH_TOKEN);
    expect(outcome.kind).toBe("transient");
    if (outcome.kind === "transient") {
      expect(outcome.reason).toBe("platform_bug");
    }
  });

  it("2xx success → success AND original refresh_token preserved", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: "at-new",
          expiry_date: 1900000000000,
          scope: "openid email",
          token_type: "Bearer",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    const outcome = await refreshDelegatedTokenClassified(config, SEED_REFRESH_TOKEN);
    expect(outcome.kind).toBe("success");
    if (outcome.kind === "success") {
      // The Cloud Function never returns a new refresh_token; the classifier
      // must echo the original so storage retains it.
      expect(outcome.tokens.refresh_token).toBe(SEED_REFRESH_TOKEN);
      expect(outcome.tokens.access_token).toBe("at-new");
    }
  });
});
