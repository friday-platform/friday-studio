import { Buffer } from "node:buffer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { OAuthConfig } from "../providers/types.ts";
import {
  buildDelegatedAuthUrl,
  parseDelegatedCallback,
  refreshDelegatedToken,
  refreshDelegatedTokenClassified,
} from "./delegated.ts";

const config: Extract<OAuthConfig, { mode: "delegated" }> = {
  mode: "delegated",
  authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
  delegatedExchangeUri: "https://exchange.example.com",
  delegatedRefreshUri: "https://exchange.example.com/refreshToken",
  clientId: "test-client-id",
  scopes: ["openid", "email"],
  extraAuthParams: { access_type: "offline", prompt: "consent" },
  encodeState: ({ csrfToken, finalRedirectUri }) =>
    Buffer.from(JSON.stringify({ uri: finalRedirectUri, manual: false, csrf: csrfToken })).toString(
      "base64",
    ),
};

describe("buildDelegatedAuthUrl", () => {
  it("uses delegatedExchangeUri as redirect_uri (not the local callback)", () => {
    const url = new URL(buildDelegatedAuthUrl(config, "csrf-1", "http://localhost:3100/cb"));
    expect(url.searchParams.get("redirect_uri")).toBe("https://exchange.example.com");
    expect(url.searchParams.get("client_id")).toBe("test-client-id");
    expect(url.searchParams.get("response_type")).toBe("code");
  });

  it("encodes finalRedirectUri inside state, not as redirect_uri", () => {
    const url = new URL(buildDelegatedAuthUrl(config, "csrf-1", "http://localhost:3100/cb"));
    const decoded = z
      .object({ uri: z.string(), csrf: z.string(), manual: z.boolean() })
      .parse(
        JSON.parse(Buffer.from(url.searchParams.get("state") ?? "", "base64").toString("utf8")),
      );
    expect(decoded.uri).toBe("http://localhost:3100/cb");
    expect(decoded.csrf).toBe("csrf-1");
    expect(decoded.manual).toBe(false);
  });

  it("includes extraAuthParams", () => {
    const url = new URL(buildDelegatedAuthUrl(config, "csrf-1", "http://localhost:3100/cb"));
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
  });

  it("uses provided scopes over config scopes", () => {
    const url = new URL(
      buildDelegatedAuthUrl(config, "csrf-1", "http://localhost:3100/cb", ["scope-x", "scope-y"]),
    );
    expect(url.searchParams.get("scope")).toBe("scope-x scope-y");
  });
});

describe("parseDelegatedCallback", () => {
  it("parses tokens and converts expiry_date ms → expires_at seconds", () => {
    const tokens = parseDelegatedCallback(
      {
        access_token: "at-1",
        refresh_token: "rt-1",
        expiry_date: "1700000000000",
        scope: "openid email",
        token_type: "Bearer",
        state: "csrf-1",
      },
      "csrf-1",
    );
    expect(tokens.access_token).toBe("at-1");
    expect(tokens.refresh_token).toBe("rt-1");
    expect(tokens.expires_at).toBe(1700000000); // ms / 1000
    expect(tokens.scope).toBe("openid email");
    expect(tokens.token_type).toBe("Bearer");
  });

  it("compares state against the bare CSRF (not base64-decoded)", () => {
    expect(() =>
      parseDelegatedCallback(
        { access_token: "at-1", expiry_date: "1700000000000", state: "wrong-csrf" },
        "csrf-1",
      ),
    ).toThrow(/state mismatch/i);
  });

  it("throws when required fields are missing", () => {
    expect(() =>
      parseDelegatedCallback({ state: "csrf-1" } as unknown as Record<string, string>, "csrf-1"),
    ).toThrow(/missing required fields/i);
  });

  it("treats refresh_token as optional", () => {
    const tokens = parseDelegatedCallback(
      { access_token: "at-1", expiry_date: "1700000000000", state: "csrf-1" },
      "csrf-1",
    );
    expect(tokens.refresh_token).toBeUndefined();
  });

  it("defaults token_type to Bearer when missing", () => {
    const tokens = parseDelegatedCallback(
      { access_token: "at-1", expiry_date: "1700000000000", state: "csrf-1" },
      "csrf-1",
    );
    expect(tokens.token_type).toBe("Bearer");
  });
});

describe("refreshDelegatedToken", () => {
  afterEach(() => vi.restoreAllMocks());

  it("POSTs refresh_token JSON, preserves original refresh_token, converts ms→seconds", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(
          JSON.stringify({
            access_token: "at-2",
            expiry_date: 1800000000000,
            scope: "openid",
            token_type: "Bearer",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );

    const tokens = await refreshDelegatedToken(config, "rt-original");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://exchange.example.com/refreshToken",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refresh_token: "rt-original" }),
      }),
    );
    expect(tokens.access_token).toBe("at-2");
    expect(tokens.refresh_token).toBe("rt-original"); // preserved
    expect(tokens.expires_at).toBe(1800000000);
    expect(tokens.scope).toBe("openid");
  });

  it("throws token_dead on 4xx invalid_grant body", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "invalid_grant" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await expect(refreshDelegatedToken(config, "rt-1")).rejects.toThrow(/token_dead/);
  });

  it("throws transient platform_bug on 2xx with malformed body", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ unexpected: "shape" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    await expect(refreshDelegatedToken(config, "rt-1")).rejects.toThrow(
      /transient reason=platform_bug/,
    );
  });
});

describe("refreshDelegatedTokenClassified", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("kind=success on 2xx valid body, preserves refresh_token and converts ms→seconds", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(
          JSON.stringify({
            access_token: "at-2",
            expiry_date: 1800000000000,
            scope: "openid",
            token_type: "Bearer",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );

    const outcome = await refreshDelegatedTokenClassified(config, "rt-original");

    expect(outcome).toEqual({
      kind: "success",
      tokens: {
        access_token: "at-2",
        refresh_token: "rt-original",
        expires_at: 1800000000,
        scope: "openid",
        token_type: "Bearer",
      },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("passes an AbortSignal to fetch (drives the timeout branch via err.name='AbortError')", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ access_token: "at-2", expiry_date: 1800000000000 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

    await refreshDelegatedTokenClassified(config, "rt-1");

    const init = fetchMock.mock.calls[0]?.[1];
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  // The classifier branches only on `error === "invalid_grant"`. Each body
  // variant Google can return (bare, with description, with error_subtype)
  // must map to the same `kind: "token_dead"` outcome. One row per
  // documented shape pins the contract without testing the type system.
  it.each([
    { label: "bare invalid_grant", body: { error: "invalid_grant" } },
    {
      label: "with error_description (Google's documented revoked shape)",
      body: { error: "invalid_grant", error_description: "Token has been expired or revoked." },
    },
    {
      label: "with error_subtype (Google's documented session-control failure)",
      body: {
        error: "invalid_grant",
        error_subtype: "invalid_rapt",
        error_description: "Reauth related error (invalid_rapt)",
      },
    },
  ])("kind=token_dead on 400 invalid_grant — $label", async ({ body }) => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify(body), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }),
      );

    const outcome = await refreshDelegatedTokenClassified(config, "rt-1");

    expect(outcome).toEqual({ kind: "token_dead" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("kind=transient platform_bug on 4xx with other error code", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: "invalid_client", error_description: "bad client" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    const outcome = await refreshDelegatedTokenClassified(config, "rt-1");

    expect(outcome.kind).toBe("transient");
    if (outcome.kind === "transient") {
      expect(outcome.reason).toBe("platform_bug");
      expect(outcome.detail).toMatch(/invalid_client/);
    }
  });

  it("kind=transient platform_bug on 4xx with non-JSON body", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      Promise.resolve(new Response("not json at all", { status: 400, statusText: "Bad Request" })),
    );

    const outcome = await refreshDelegatedTokenClassified(config, "rt-1");

    expect(outcome.kind).toBe("transient");
    if (outcome.kind === "transient") {
      expect(outcome.reason).toBe("platform_bug");
    }
  });

  it("kind=transient http_5xx on 5xx (single attempt, no retry)", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(() =>
        Promise.resolve(new Response("internal server error", { status: 500 })),
      );

    const outcome = await refreshDelegatedTokenClassified(config, "rt-1");

    expect(outcome.kind).toBe("transient");
    if (outcome.kind === "transient") {
      expect(outcome.reason).toBe("http_5xx");
    }
    // Classifier makes exactly one attempt — proves no internal retry loop.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("kind=transient http_429 on 429", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      Promise.resolve(new Response("rate limited", { status: 429 })),
    );

    const outcome = await refreshDelegatedTokenClassified(config, "rt-1");

    expect(outcome.kind).toBe("transient");
    if (outcome.kind === "transient") {
      expect(outcome.reason).toBe("http_429");
    }
  });

  it("kind=transient network when fetch throws a non-AbortError", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      Object.assign(new Error("ECONNREFUSED"), { name: "TypeError" }),
    );

    const outcome = await refreshDelegatedTokenClassified(config, "rt-1");

    expect(outcome.kind).toBe("transient");
    if (outcome.kind === "transient") {
      expect(outcome.reason).toBe("network");
      expect(outcome.detail).toMatch(/ECONNREFUSED/);
    }
  });

  it("kind=transient timeout when fetch rejects with AbortError", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      const err = new Error("The operation was aborted due to timeout");
      err.name = "AbortError";
      return Promise.reject(err);
    });

    const outcome = await refreshDelegatedTokenClassified(config, "rt-1");

    expect(outcome.kind).toBe("transient");
    if (outcome.kind === "transient") {
      expect(outcome.reason).toBe("timeout");
    }
  });

  // Body-stream errors on 2xx response (headers arrived, body never did
  // or got truncated) must surface as transient — not escape as an
  // unhandled rejection up to the caller and turn into a generic 500.
  it("kind=transient network when 2xx body read throws (truncated stream)", async () => {
    const failingBody = new ReadableStream({
      start(controller) {
        controller.error(new TypeError("network error: connection reset"));
      },
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(failingBody, { status: 200, headers: { "Content-Type": "application/json" } }),
    );

    const outcome = await refreshDelegatedTokenClassified(config, "rt-1");

    expect(outcome.kind).toBe("transient");
    if (outcome.kind === "transient") {
      expect(outcome.reason).toBe("network");
    }
  });

  // Token-redaction guard for log + detail leaks. Refresh endpoint is a
  // secret boundary; if the upstream ever returns / echoes an
  // `access_token` (or refresh / id token) in a body shape we don't
  // expect, the value must NOT survive into the logger or into the
  // `detail` string that gets exposed via `/internal/v1/credentials/:id`.
  it("redacts access_token from detail on 2xx non-JSON body", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response('garbled access_token="leak-12345" refresh_token="leak-rt-67890" ok=true', {
        status: 200,
      }),
    );

    const outcome = await refreshDelegatedTokenClassified(config, "rt-1");

    expect(outcome.kind).toBe("transient");
    if (outcome.kind === "transient") {
      expect(outcome.reason).toBe("platform_bug");
      expect(outcome.detail).not.toMatch(/leak-12345/);
      expect(outcome.detail).not.toMatch(/leak-rt-67890/);
      expect(outcome.detail).toMatch(/REDACTED/);
    }
  });

  it("redacts access_token from detail on 4xx non-JSON body", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response('<html><body>access_token="leak-9999"</body></html>', {
        status: 400,
        statusText: "Bad Request",
      }),
    );

    const outcome = await refreshDelegatedTokenClassified(config, "rt-1");

    expect(outcome.kind).toBe("transient");
    if (outcome.kind === "transient") {
      expect(outcome.reason).toBe("platform_bug");
      expect(outcome.detail).not.toMatch(/leak-9999/);
    }
  });

  it("redacts JSON-quoted access_token from detail on 4xx missing-error body", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ unexpected: true, access_token: "leak-jsn-001" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const outcome = await refreshDelegatedTokenClassified(config, "rt-1");

    expect(outcome.kind).toBe("transient");
    if (outcome.kind === "transient") {
      expect(outcome.reason).toBe("platform_bug");
      expect(outcome.detail).not.toMatch(/leak-jsn-001/);
    }
  });
});
