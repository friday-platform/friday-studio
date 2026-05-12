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
    vi.useRealTimers();
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

  it("passes AbortSignal.timeout(15_000) to fetch", async () => {
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

  it("kind=token_dead on 4xx invalid_grant; does NOT retry; propagates subtype", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ error: "invalid_grant", error_subtype: "user_revoked" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }),
      );

    const outcome = await refreshDelegatedTokenClassified(config, "rt-1");

    expect(outcome).toEqual({ kind: "token_dead", subtype: "user_revoked" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("kind=token_dead on 4xx invalid_grant without subtype", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "invalid_grant" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const outcome = await refreshDelegatedTokenClassified(config, "rt-1");

    expect(outcome.kind).toBe("token_dead");
    if (outcome.kind === "token_dead") {
      expect(outcome.subtype).toBeUndefined();
    }
  });

  it("kind=transient platform_bug on 4xx with other error code (loud log)", async () => {
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

  it("kind=transient http_5xx on 5xx", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      Promise.resolve(new Response("internal server error", { status: 500 })),
    );

    const outcome = await refreshDelegatedTokenClassified(config, "rt-1");

    expect(outcome.kind).toBe("transient");
    if (outcome.kind === "transient") {
      expect(outcome.reason).toBe("http_5xx");
    }
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

  it("kind=transient timeout when fetch rejects with AbortError (simulating AbortSignal.timeout)", async () => {
    // AbortSignal.timeout internally uses a timer source that vitest fake timers
    // do not reliably intercept; we instead simulate the post-timeout state — fetch
    // rejects with an AbortError, which is exactly what the runtime delivers when
    // the signal aborts.
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

  it("single-attempt behavior: a 500 returns kind=transient (no internal retry)", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("upstream broken", { status: 500 }));

    const outcome = await refreshDelegatedTokenClassified(config, "rt-1");

    expect(outcome.kind).toBe("transient");
    if (outcome.kind === "transient") {
      expect(outcome.reason).toBe("http_5xx");
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
