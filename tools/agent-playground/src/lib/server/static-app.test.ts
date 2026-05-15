import { env } from "node:process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildStaticApp } from "./static-app.ts";

const DAEMON_URL = "https://daemon.example:9443";

const originalEnv = {
  FRIDAYD_URL: env.FRIDAYD_URL,
  FRIDAY_TLS_CERT: env.FRIDAY_TLS_CERT,
  FRIDAY_TLS_KEY: env.FRIDAY_TLS_KEY,
};

function restoreEnv(): void {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("production static app route ordering", () => {
  beforeEach(() => {
    env.FRIDAYD_URL = DAEMON_URL;
    delete env.FRIDAY_TLS_CERT;
    delete env.FRIDAY_TLS_KEY;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    restoreEnv();
  });

  it("routes /api/export through the API before the SPA fallback", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (url === `${DAEMON_URL}/api/workspaces/ws-1/chat/missing?full=true`) {
          return jsonResponse({ error: "Chat not found" }, 404);
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );
    const app = buildStaticApp({
      daemonUrl: DAEMON_URL,
      tunnelUrl: "https://tunnel.example:9090",
      indexHtml: () => Promise.resolve("<!doctype html><p>spa fallback</p>"),
    });

    const apiRes = await app.request("/api/export/ws-1/missing");
    const fallbackRes = await app.request("/platform/ws-1/chat/chat-1");

    expect(apiRes.status).toBe(404);
    expect(apiRes.headers.get("content-type")).toContain("application/json");
    expect(await apiRes.json()).toEqual({ error: "Chat not found" });
    expect(fallbackRes.status).toBe(200);
    expect(await fallbackRes.text()).toContain("spa fallback");
  });
});
