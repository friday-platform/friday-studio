import { afterEach, describe, expect, it, vi } from "vitest";

const DAEMON_URL = "https://daemon.example:9443";

// Pin the daemon URL the export route sees. `effectiveDaemonUrl` is
// short-circuited by Vite's `__FRIDAY_DAEMON_BASE_URL__` define when these
// tests run via `npx vitest` inside the package directory, so the env-based
// stub used previously is not enough. Same mock as `routes/export.test.ts`.
vi.mock("./daemon-url.ts", () => ({
  effectiveDaemonUrl: () => DAEMON_URL,
}));

const { buildStaticApp } = await import("./static-app.ts");

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("production static app route ordering", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
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
