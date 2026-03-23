import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { Config } from "./config.ts";
import { createWebhookRoutes } from "./routes.ts";

// ---------------------------------------------------------------------------
// Setup — mock atlasd that records forwarded requests
// ---------------------------------------------------------------------------

const forwarded: { workspaceId: string; signalId: string; payload: unknown }[] = [];
let mockServer: Hono;
let mockPort: number;

function createTestConfig(overrides?: Partial<Config>): Config {
  return {
    atlasdUrl: `http://localhost:${mockPort}`,
    webhookSecret: "",
    port: 9999,
    noTunnel: true,
    ...overrides,
  };
}

beforeAll(() => {
  mockPort = 18787;
  mockServer = new Hono();

  mockServer.post("/api/workspaces/:workspaceId/signals/:signalId", async (c) => {
    const { workspaceId, signalId } = c.req.param();
    const body = await c.req.json();
    forwarded.push({ workspaceId, signalId, payload: body.payload });
    return c.json({ message: "Signal completed", sessionId: "test-session-123" });
  });

  Deno.serve({ port: mockPort, hostname: "127.0.0.1", onListen: () => {} }, mockServer.fetch);
});

afterAll(() => {
  forwarded.length = 0;
});

// ---------------------------------------------------------------------------
// Route tests
// ---------------------------------------------------------------------------

describe("webhook routes", () => {
  test("GET / returns service info", async () => {
    const config = createTestConfig();
    const app = createWebhookRoutes(config, () => "https://test.trycloudflare.com");

    const res = await app.request("/");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.service).toBe("webhook-tunnel");
    expect(body.providers).toContain("github");
    expect(body.url).toBe("https://test.trycloudflare.com");
  });

  test("returns 400 for unknown provider", async () => {
    const config = createTestConfig();
    const app = createWebhookRoutes(config, () => null);

    const res = await app.request("/hook/gitlab/my_space/review-pr", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toContain("Unknown provider: gitlab");
  });

  test("skips irrelevant GitHub events", async () => {
    const config = createTestConfig();
    const app = createWebhookRoutes(config, () => null);

    const res = await app.request("/hook/github/my_space/review-pr", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-github-event": "deployment" },
      body: JSON.stringify({ deployment: {} }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe("skipped");
  });

  test("forwards GitHub PR opened to atlasd", async () => {
    const config = createTestConfig();
    const app = createWebhookRoutes(config, () => null);
    const before = forwarded.length;

    const res = await app.request("/hook/github/my_space/review-pr", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-github-event": "pull_request" },
      body: JSON.stringify({
        action: "opened",
        pull_request: { html_url: "https://github.com/org/repo/pull/99" },
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe("forwarded");
    expect(body.sessionId).toBe("test-session-123");

    expect(forwarded.length).toBe(before + 1);
    const last = forwarded[forwarded.length - 1];
    expect(last?.workspaceId).toBe("my_space");
    expect(last?.signalId).toBe("review-pr");
    expect(last?.payload).toEqual({ pr_url: "https://github.com/org/repo/pull/99" });
  });

  test("forwards Bitbucket PR created to atlasd", async () => {
    const config = createTestConfig();
    const app = createWebhookRoutes(config, () => null);
    const res = await app.request("/hook/bitbucket/tender_cherry/review-pr", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-event-key": "pullrequest:created" },
      body: JSON.stringify({
        pullrequest: {
          links: { html: { href: "https://bitbucket.org/ws/repo/pull-requests/42" } },
        },
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe("forwarded");

    const last = forwarded[forwarded.length - 1];
    expect(last?.workspaceId).toBe("tender_cherry");
    expect(last?.signalId).toBe("review-pr");
    expect(last?.payload).toEqual({ pr_url: "https://bitbucket.org/ws/repo/pull-requests/42" });
  });

  test("forwards raw payload as-is", async () => {
    const config = createTestConfig();
    const app = createWebhookRoutes(config, () => null);

    const payload = { project_key: "DEV", repo_url: "https://bitbucket.org/ws/repo" };

    const res = await app.request("/hook/raw/rolled_salmon/process-labeled-bugs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    expect(res.status).toBe(200);
    const last = forwarded[forwarded.length - 1];
    expect(last?.workspaceId).toBe("rolled_salmon");
    expect(last?.signalId).toBe("process-labeled-bugs");
    expect(last?.payload).toEqual(payload);
  });

  test("returns 502 when atlasd is unreachable", async () => {
    const config = createTestConfig({ atlasdUrl: "http://localhost:1" });
    const app = createWebhookRoutes(config, () => null);

    const res = await app.request("/hook/github/my_space/review-pr", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-github-event": "pull_request" },
      body: JSON.stringify({
        action: "opened",
        pull_request: { html_url: "https://github.com/org/repo/pull/1" },
      }),
    });

    expect(res.status).toBe(502);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toContain("Cannot reach atlasd");
  });

  test("returns 401 when signature verification fails", async () => {
    const config = createTestConfig({ webhookSecret: "supersecret" });
    const app = createWebhookRoutes(config, () => null);

    const res = await app.request("/hook/github/my_space/review-pr", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-github-event": "pull_request",
        "x-hub-signature-256": "sha256=wrong",
      },
      body: JSON.stringify({
        action: "opened",
        pull_request: { html_url: "https://github.com/org/repo/pull/1" },
      }),
    });

    expect(res.status).toBe(401);
  });
});
