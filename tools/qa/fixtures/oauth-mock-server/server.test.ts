import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startMockOAuthServer } from "./server.ts";

type Handle = Awaited<ReturnType<typeof startMockOAuthServer>>;

interface ControlCountsResponse {
  total: number;
  byMode: Record<string, number>;
  flakyCallCount: number;
}

interface RefreshSuccessBody {
  access_token: string;
  expiry_date: number;
  token_type: string;
  scope: string;
}

interface OAuthErrorBody {
  error: string;
  error_description?: string;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function expectControlCounts(value: unknown): ControlCountsResponse {
  if (!isPlainRecord(value)) throw new Error("counts response is not an object");
  const total = value["total"];
  const byMode = value["byMode"];
  const flakyCallCount = value["flakyCallCount"];
  if (typeof total !== "number") throw new Error("counts.total missing");
  if (typeof flakyCallCount !== "number") throw new Error("counts.flakyCallCount missing");
  if (!isPlainRecord(byMode)) throw new Error("counts.byMode missing");
  const validatedByMode: Record<string, number> = {};
  for (const [key, v] of Object.entries(byMode)) {
    if (typeof v !== "number") throw new Error(`counts.byMode.${key} is not a number`);
    validatedByMode[key] = v;
  }
  return { total, byMode: validatedByMode, flakyCallCount };
}

function expectRefreshSuccess(value: unknown): RefreshSuccessBody {
  if (!isPlainRecord(value)) throw new Error("refresh response is not an object");
  const access_token = value["access_token"];
  const expiry_date = value["expiry_date"];
  const token_type = value["token_type"];
  const scope = value["scope"];
  if (typeof access_token !== "string") throw new Error("access_token missing");
  if (typeof expiry_date !== "number") throw new Error("expiry_date missing");
  if (typeof token_type !== "string") throw new Error("token_type missing");
  if (typeof scope !== "string") throw new Error("scope missing");
  return { access_token, expiry_date, token_type, scope };
}

function expectOAuthError(value: unknown): OAuthErrorBody {
  if (!isPlainRecord(value)) throw new Error("oauth error is not an object");
  const error = value["error"];
  if (typeof error !== "string") throw new Error("error field missing");
  const description = value["error_description"];
  return typeof description === "string" ? { error, error_description: description } : { error };
}

async function setMode(baseUrl: string, mode: string, payload?: unknown): Promise<void> {
  const res = await fetch(`${baseUrl}/control/mode`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload === undefined ? { mode } : { mode, payload }),
  });
  if (res.status !== 200) {
    throw new Error(`setMode failed: ${res.status}`);
  }
  await res.body?.cancel();
}

async function callRefresh(baseUrl: string): Promise<Response> {
  return await fetch(`${baseUrl}/refreshToken`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ refresh_token: "test-refresh-token" }),
  });
}

async function getCounts(baseUrl: string): Promise<ControlCountsResponse> {
  const res = await fetch(`${baseUrl}/control/counts`, { method: "POST" });
  return expectControlCounts(await res.json());
}

describe("startMockOAuthServer", () => {
  let handle: Handle;

  beforeEach(async () => {
    handle = await startMockOAuthServer(0);
  });

  afterEach(async () => {
    await handle.stop();
  });

  it("default mode is success and returns 200 with token fields", async () => {
    const res = await callRefresh(handle.url);
    expect(res.status).toEqual(200);
    const body = expectRefreshSuccess(await res.json());
    expect(body.token_type).toEqual("Bearer");
    expect(body.scope.length).toBeGreaterThan(0);
    expect(body.access_token.length).toBeGreaterThan(0);
    expect(body.expiry_date).toBeGreaterThan(0);
  });

  it("invalid_grant returns HTTP 400 with invalid_grant error", async () => {
    await setMode(handle.url, "invalid_grant");
    const res = await callRefresh(handle.url);
    expect(res.status).toEqual(400);
    const body = expectOAuthError(await res.json());
    expect(body.error).toEqual("invalid_grant");
    expect(body.error_description ?? "").toMatch(/expired|revoked/i);
  });

  it("invalid_client returns HTTP 400 with invalid_client error", async () => {
    await setMode(handle.url, "invalid_client");
    const res = await callRefresh(handle.url);
    expect(res.status).toEqual(400);
    const body = expectOAuthError(await res.json());
    expect(body.error).toEqual("invalid_client");
  });

  it("http_500_text returns 500 plain text matching real Cloud Function", async () => {
    await setMode(handle.url, "http_500_text");
    const res = await callRefresh(handle.url);
    expect(res.status).toEqual(500);
    expect(res.headers.get("content-type") ?? "").toMatch(/text\/plain/);
    const body = await res.text();
    expect(body).toEqual("An error occurred during token refresh.");
  });

  it("http_500_json returns 500 with upstream-shaped JSON", async () => {
    await setMode(handle.url, "http_500_json");
    const res = await callRefresh(handle.url);
    expect(res.status).toEqual(500);
    expect(res.headers.get("content-type") ?? "").toMatch(/application\/json/);
    const body = expectOAuthError(await res.json());
    expect(body.error.length).toBeGreaterThan(0);
  });

  it("http_429 returns 429", async () => {
    await setMode(handle.url, "http_429");
    const res = await callRefresh(handle.url);
    expect(res.status).toEqual(429);
    await res.body?.cancel();
  });

  it("malformed_body returns 200 with garbage JSON body", async () => {
    await setMode(handle.url, "malformed_body");
    const res = await callRefresh(handle.url);
    expect(res.status).toEqual(200);
    const text = await res.text();
    expect(() => JSON.parse(text)).toThrow();
  });

  it("hang never resolves until the client aborts", async () => {
    await setMode(handle.url, "hang");
    const ac = new AbortController();
    const inflight = fetch(`${handle.url}/refreshToken`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refresh_token: "test" }),
      signal: ac.signal,
    });
    let settled = false;
    inflight.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await new Promise((r) => setTimeout(r, 150));
    expect(settled).toEqual(false);
    ac.abort();
    await expect(inflight).rejects.toThrow();
  });

  it("netfail closes the connection mid-response", async () => {
    await setMode(handle.url, "netfail");
    await expect(callRefresh(handle.url)).rejects.toThrow();
  });

  it("flaky returns http_500_text first, then the explicit mode on subsequent calls", async () => {
    await setMode(handle.url, "flaky");
    const first = await callRefresh(handle.url);
    expect(first.status).toEqual(500);
    expect(await first.text()).toEqual("An error occurred during token refresh.");

    const second = await callRefresh(handle.url);
    expect(second.status).toEqual(200);
    const body = expectRefreshSuccess(await second.json());
    expect(body.access_token.length).toBeGreaterThan(0);

    const counts = await getCounts(handle.url);
    expect(counts.flakyCallCount).toEqual(2);
    expect(counts.total).toEqual(2);
  });

  it("/control/counts tracks calls per mode", async () => {
    await callRefresh(handle.url);
    await setMode(handle.url, "invalid_grant");
    await callRefresh(handle.url);
    await callRefresh(handle.url);

    const counts = await getCounts(handle.url);
    expect(counts.total).toEqual(3);
    expect(counts.byMode["success"]).toEqual(1);
    expect(counts.byMode["invalid_grant"]).toEqual(2);
  });

  it("/control/reset clears mode and counts", async () => {
    await setMode(handle.url, "invalid_grant");
    await callRefresh(handle.url);

    const resetRes = await fetch(`${handle.url}/control/reset`, { method: "POST" });
    expect(resetRes.status).toEqual(200);
    await resetRes.body?.cancel();

    const res = await callRefresh(handle.url);
    expect(res.status).toEqual(200);
    const counts = await getCounts(handle.url);
    expect(counts.total).toEqual(1);
    expect(counts.byMode["success"]).toEqual(1);
  });

  it("POST /callback redirects 302 to the localhost uri in state with synthetic tokens", async () => {
    const state = btoa(
      JSON.stringify({ uri: "http://localhost:54321/cb", manual: false, csrf: "csrf-abc" }),
    );
    const res = await fetch(
      `${handle.url}/callback?code=test-code&state=${encodeURIComponent(state)}`,
      { method: "POST", redirect: "manual" },
    );
    expect(res.status).toEqual(302);
    const location = res.headers.get("location");
    if (location === null) throw new Error("missing location header");
    const url = new URL(location);
    expect(url.origin).toEqual("http://localhost:54321");
    expect(url.pathname).toEqual("/cb");
    expect(url.searchParams.get("access_token")).toBeTruthy();
    expect(url.searchParams.get("refresh_token")).toBeTruthy();
    expect(url.searchParams.get("expiry_date")).toBeTruthy();
    expect(url.searchParams.get("token_type")).toEqual("Bearer");
    expect(url.searchParams.get("scope")).toBeTruthy();
    expect(url.searchParams.get("state")).toEqual("csrf-abc");
    await res.body?.cancel();
  });
});
