/**
 * Input validation tests for workspace routes (POST /add, POST /add-batch,
 * POST /:workspaceId/update).
 *
 * Tests that zValidator rejects invalid payloads before handlers execute.
 */

import process from "node:process";
import type { WorkspaceConfig } from "@atlas/config";
import { startNatsTestServer, type TestNatsServer } from "@atlas/core/test-utils/nats-test-server";
import { createStubPlatformModels } from "@atlas/llm";
import type { WorkspaceManager } from "@atlas/workspace";
import { Hono } from "hono";
import { connect, type NatsConnection } from "nats";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import type { AppContext, AppVariables } from "../../src/factory.ts";
import {
  extractJobIntegrations,
  formatJobName,
  injectBundledAgentRefs,
  workspacesRoutes,
} from "./index.ts";

vi.mock("../me/adapter.ts", () => ({ getCurrentUser: vi.fn().mockResolvedValue({ ok: false }) }));

vi.mock("@atlas/core/workspace-members/storage", () => ({
  WorkspaceMemberStorage: {
    get: vi
      .fn()
      .mockImplementation((userId: string, wsId: string) =>
        Promise.resolve({
          ok: true,
          data: { userId, wsId, role: "owner", addedAt: "2026-05-11T00:00:00.000Z" },
        }),
      ),
    listByUser: vi.fn().mockResolvedValue({ ok: true, data: [] }),
    listByWorkspace: vi.fn().mockResolvedValue({ ok: true, data: [] }),
    put: vi.fn().mockResolvedValue({ ok: true, data: null }),
    putIfAbsent: vi.fn().mockResolvedValue({ ok: true, data: null }),
    delete: vi.fn().mockResolvedValue({ ok: true, data: undefined }),
  },
  ensureWorkspaceMembersKVBucket: vi.fn(),
  initWorkspaceMemberStorage: vi.fn(),
  resetWorkspaceMemberStorageForTests: vi.fn(),
}));

function createTestApp() {
  const mockWorkspaceManager = {
    find: vi.fn().mockResolvedValue(null),
    list: vi.fn().mockResolvedValue([]),
    getWorkspaceConfig: vi.fn().mockResolvedValue(null),
    registerWorkspace: vi.fn(),
    deleteWorkspace: vi.fn(),
  } as unknown as WorkspaceManager;
  const triggerWorkspaceSignal = vi
    .fn()
    .mockResolvedValue({ sessionId: "sess-1", output: [], artifactIds: [], summary: "" });
  const publishSignalToJetStream = vi.fn().mockResolvedValue(undefined);

  const mockContext: AppContext = {
    startTime: Date.now(),
    sseClients: new Map(),
    sseStreams: new Map(),
    getWorkspaceManager: () => mockWorkspaceManager,
    getAgentRegistry: vi.fn(),
    getOrCreateChatSdkInstance: vi.fn(),
    daemon: {
      getWorkspaceManager: () => mockWorkspaceManager,
      triggerWorkspaceSignal,
      publishSignalToJetStream,
    } as unknown as AppContext["daemon"],
    streamRegistry: {} as AppContext["streamRegistry"],
    chatTurnRegistry: {} as AppContext["chatTurnRegistry"],
    sessionStreamRegistry: {} as AppContext["sessionStreamRegistry"],
    sessionHistoryAdapter: {} as AppContext["sessionHistoryAdapter"],
    sessionDispatchRegistry: {} as AppContext["sessionDispatchRegistry"],
    exposeKernel: false,
    platformModels: createStubPlatformModels(),
  };

  const app = new Hono<AppVariables>();
  app.use("*", async (c, next) => {
    c.set("app", mockContext);
    c.set("userId", "test-user");
    await next();
  });
  app.route("/workspaces", workspacesRoutes);

  return { app, mockWorkspaceManager, triggerWorkspaceSignal, publishSignalToJetStream };
}

function post(
  app: ReturnType<typeof createTestApp>["app"],
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

const INTERNAL_SIGNAL_BYPASS_HEADER = "x-friday-internal-signal-bypass";
const INTERNAL_SIGNAL_BYPASS_TOKEN_ENV = "FRIDAY_INTERNAL_SIGNAL_BYPASS_TOKEN";

describe("POST /workspaces/:workspaceId/signals/:signalId bypass guard", () => {
  test("rejects public JSON callers that set bypassConcurrency", async () => {
    const previous = process.env[INTERNAL_SIGNAL_BYPASS_TOKEN_ENV];
    process.env[INTERNAL_SIGNAL_BYPASS_TOKEN_ENV] = "test-token";
    try {
      const { app, triggerWorkspaceSignal } = createTestApp();
      const res = await post(app, "/workspaces/ws-1/signals/sig-1", {
        payload: {},
        bypassConcurrency: true,
      });

      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({
        error: "bypassConcurrency is internal to workspace-chat job tools",
      });
      expect(triggerWorkspaceSignal).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env[INTERNAL_SIGNAL_BYPASS_TOKEN_ENV];
      else process.env[INTERNAL_SIGNAL_BYPASS_TOKEN_ENV] = previous;
    }
  });

  test("allows internal job-tool callers with the bypass token", async () => {
    const previous = process.env[INTERNAL_SIGNAL_BYPASS_TOKEN_ENV];
    process.env[INTERNAL_SIGNAL_BYPASS_TOKEN_ENV] = "test-token";
    try {
      const { app, triggerWorkspaceSignal } = createTestApp();
      const res = await post(
        app,
        "/workspaces/ws-1/signals/sig-1",
        { payload: {}, bypassConcurrency: true },
        { [INTERNAL_SIGNAL_BYPASS_HEADER]: "test-token" },
      );

      expect(res.status).toBe(200);
      expect(triggerWorkspaceSignal).toHaveBeenCalledOnce();
    } finally {
      if (previous === undefined) delete process.env[INTERNAL_SIGNAL_BYPASS_TOKEN_ENV];
      else process.env[INTERNAL_SIGNAL_BYPASS_TOKEN_ENV] = previous;
    }
  });
});

describe("POST /workspaces/:workspaceId/signals/:signalId envelope guard", () => {
  test("a bare body (no envelope keys) routes to webhook mode — bytes preserved, 202 returned", async () => {
    // Same body shape that used to 400 with the envelope guard. Under
    // the byte-for-byte reverse-proxy design, a body without any
    // envelope key is a webhook payload: the dispatch happens via nowait
    // (cascade runs async) and the raw bytes + headers ride in the
    // envelope so the agent can verify HMAC against them.
    const { app, triggerWorkspaceSignal, publishSignalToJetStream } = createTestApp();
    const res = await post(app, "/workspaces/ws-1/signals/sig-1", { input: "hello" });

    expect(res.status).toBe(202);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      message: "Webhook accepted",
      status: "accepted",
      workspaceId: "ws-1",
      signalId: "sig-1",
    });
    expect(triggerWorkspaceSignal).not.toHaveBeenCalled();
    expect(publishSignalToJetStream).toHaveBeenCalledOnce();
    const publishArgs = publishSignalToJetStream.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(publishArgs).toMatchObject({
      workspaceId: "ws-1",
      signalId: "sig-1",
      payload: { input: "hello" },
    });
    // Body is base64-encoded for byte-fidelity.
    expect(typeof publishArgs.webhookBody).toBe("string");
    expect(atob(publishArgs.webhookBody as string)).toBe('{"input":"hello"}');
  });

  test("rejects stray keys even when a valid envelope key is also present", async () => {
    const { app, triggerWorkspaceSignal } = createTestApp();
    const res = await post(app, "/workspaces/ws-1/signals/sig-1", {
      streamId: "stream-1",
      input: "hello",
    });

    expect(res.status).toBe(400);
    expect(triggerWorkspaceSignal).not.toHaveBeenCalled();
  });

  test("rejects a bare payload on the SSE handler too (Accept: text/event-stream)", async () => {
    // The SSE handler is a separate `.post` registration dispatched by the
    // accept header — it reads rawBody directly, so its guard branch needs
    // its own coverage.
    const { app, triggerWorkspaceSignal } = createTestApp();
    const res = await post(
      app,
      "/workspaces/ws-1/signals/sig-1",
      { input: "hello" },
      { Accept: "text/event-stream" },
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('{"payload"');
    expect(triggerWorkspaceSignal).not.toHaveBeenCalled();
  });

  test("allows a properly enveloped body through the guard", async () => {
    const previous = process.env[INTERNAL_SIGNAL_BYPASS_TOKEN_ENV];
    process.env[INTERNAL_SIGNAL_BYPASS_TOKEN_ENV] = "test-token";
    try {
      const { app, triggerWorkspaceSignal } = createTestApp();
      const res = await post(
        app,
        "/workspaces/ws-1/signals/sig-1",
        { payload: { input: "hello" }, bypassConcurrency: true },
        { [INTERNAL_SIGNAL_BYPASS_HEADER]: "test-token" },
      );

      expect(res.status).toBe(200);
      expect(triggerWorkspaceSignal).toHaveBeenCalledOnce();
    } finally {
      if (previous === undefined) delete process.env[INTERNAL_SIGNAL_BYPASS_TOKEN_ENV];
      else process.env[INTERNAL_SIGNAL_BYPASS_TOKEN_ENV] = previous;
    }
  });

  test("allows an empty body — no-payload signal triggers stay valid", async () => {
    const previous = process.env[INTERNAL_SIGNAL_BYPASS_TOKEN_ENV];
    process.env[INTERNAL_SIGNAL_BYPASS_TOKEN_ENV] = "test-token";
    try {
      const { app, triggerWorkspaceSignal } = createTestApp();
      const res = await post(
        app,
        "/workspaces/ws-1/signals/sig-1",
        { bypassConcurrency: true },
        { [INTERNAL_SIGNAL_BYPASS_HEADER]: "test-token" },
      );

      expect(res.status).toBe(200);
      expect(triggerWorkspaceSignal).toHaveBeenCalledOnce();
    } finally {
      if (previous === undefined) delete process.env[INTERNAL_SIGNAL_BYPASS_TOKEN_ENV];
      else process.env[INTERNAL_SIGNAL_BYPASS_TOKEN_ENV] = previous;
    }
  });
});

// The 202 "accepted" envelope below is consumed by FOUR downstream callers:
//   - apps/atlas-cli/src/modules/signals/trigger.ts
//   - packages/mcp-server/src/tools/signals/trigger.ts
//   - packages/system/agents/workspace-chat/tools/job-tools.ts
//   - tools/agent-playground/src/lib/components/workspace/run-job-dialog.svelte
// All four discriminate on `data.status === "accepted"` and read `correlationId`.
// These tests pin the exact field names and types so a route-side refactor
// can't silently break the discriminator in all four consumers.
describe("POST /workspaces/:workspaceId/signals/:signalId ?nowait=true publish-ack contract", () => {
  const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  test("?nowait=true returns 202 with the {status:'accepted', correlationId, workspaceId, signalId, message} envelope", async () => {
    const { app, publishSignalToJetStream, triggerWorkspaceSignal } = createTestApp();
    const res = await app.request("/workspaces/ws-1/signals/sig-1?nowait=true", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ payload: { hello: "world" } }),
    });

    expect(res.status).toBe(202);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      message: "Signal accepted",
      status: "accepted",
      workspaceId: "ws-1",
      signalId: "sig-1",
    });
    expect(body.correlationId).toMatch(UUID_V4);
    // nowait must NOT fall through to the sync cascade path
    expect(triggerWorkspaceSignal).not.toHaveBeenCalled();
    expect(publishSignalToJetStream).toHaveBeenCalledOnce();
    const publishArgs = publishSignalToJetStream.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(publishArgs).toMatchObject({
      workspaceId: "ws-1",
      signalId: "sig-1",
      payload: { hello: "world" },
    });
    expect(publishArgs.correlationId).toBe(body.correlationId);
  });

  test("only ?nowait=true is recognized — non-canonical spellings fall through to sync mode", async () => {
    // Locks the canonical-spelling decision: spelling variants like
    // `nowait=1`, `wait=false`, `wait=0` used to be aliases. They were
    // never required by any caller (the only nowait consumer was the
    // webhook-tunnel, which now uses webhook mode entirely) and they
    // invite spelling-mistake confusion. Test that non-canonical
    // spellings do NOT trigger the nowait publish-only path.
    for (const query of ["?nowait=1", "?wait=false", "?wait=0", "?nowait=yes"]) {
      const { app, publishSignalToJetStream } = createTestApp();
      // We deliberately don't await — sync mode opens a NATS subscription
      // and would hang in the unit test. We only need to confirm the
      // request did NOT take the nowait publish-only fast path.
      app
        .request(`/workspaces/ws-1/signals/sig-1${query}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ payload: {} }),
        })
        .catch(() => undefined);
      // Give the handler a tick to discriminate.
      await new Promise((r) => setTimeout(r, 50));
      expect(
        publishSignalToJetStream,
        `non-canonical ${query} must NOT take the nowait branch`,
      ).not.toHaveBeenCalled();
    }
  });

  test("returns 500 with a structured error envelope when publishSignalToJetStream throws", async () => {
    const { app, publishSignalToJetStream } = createTestApp();
    publishSignalToJetStream.mockRejectedValueOnce(new Error("JetStream unavailable"));
    const res = await app.request("/workspaces/ws-1/signals/sig-1?nowait=true", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ payload: {} }),
    });

    expect(res.status).toBe(500);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ workspaceId: "ws-1", signalId: "sig-1" });
    expect(typeof body.error).toBe("string");
    expect(body.error as string).toContain("JetStream unavailable");
  });

  test("Accept: text/event-stream wins over ?nowait=true (SSE handler short-circuits first)", async () => {
    // Topology lock: the SSE handler is a SEPARATE .post() registration
    // earlier in the route chain that branches on Accept header before
    // the JSON handler's nowait check runs. So a caller that asks for
    // both SSE AND nowait gets SSE — not a 202 publish-only response.
    // This pins the precedence so a future refactor can't silently flip it.
    const { app, publishSignalToJetStream, triggerWorkspaceSignal } = createTestApp();
    const res = await app.request("/workspaces/ws-1/signals/sig-1?nowait=true", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify({ input: "hello" }),
    });
    // The SSE handler rejects un-enveloped bodies with 400 (its own envelope
    // guard, separate from the JSON handler). Status 400 here proves we
    // reached the SSE handler, not the JSON handler (which would have
    // routed `{input: "hello"}` to webhook mode and returned 202).
    expect(res.status).toBe(400);
    expect(publishSignalToJetStream).not.toHaveBeenCalled();
    expect(triggerWorkspaceSignal).not.toHaveBeenCalled();
  });
});

// Webhook-mode tests — the byte-for-byte reverse-proxy path. The tunnel
// (apps/atlas-cli ⟶ atlasd via cloudflared) forwards upstream HTTP bytes
// unchanged. Body shape is the discriminator: no envelope keys → webhook
// mode, dispatch via nowait with the raw bytes (base64) + headers
// (lowercased) preserved on the JetStream envelope. The agent then
// recomputes HMAC against ctx.input.raw["body"] using
// ctx.input.raw["headers"]["x-hub-signature-256"].
describe("POST /workspaces/:workspaceId/signals/:signalId webhook mode (byte-for-byte)", () => {
  test("forwards a GitHub-style webhook with headers + raw body preserved", async () => {
    const { app, publishSignalToJetStream } = createTestApp();
    const githubBody = `{"action":"opened","pull_request":{"number":42},"repository":{"full_name":"acme/widgets"}}`;
    const res = await app.request("/workspaces/ws-1/signals/pr-opened", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-GitHub-Event": "pull_request",
        "X-GitHub-Delivery": "72d3162e-cc78-11e3-81ab-4c9367dc0958",
        "X-Hub-Signature-256": "sha256=abc123deadbeef",
        "User-Agent": "GitHub-Hookshot/abc",
      },
      body: githubBody,
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      message: "Webhook accepted",
      status: "accepted",
      workspaceId: "ws-1",
      signalId: "pr-opened",
    });
    expect(publishSignalToJetStream).toHaveBeenCalledOnce();
    const args = publishSignalToJetStream.mock.calls[0]?.[0] as Record<string, unknown>;
    // Body bytes round-trip via base64 — recomputing HMAC over decoded
    // bytes will match the upstream signature.
    expect(atob(args.webhookBody as string)).toBe(githubBody);
    // Headers preserved with lowercased keys, hop-by-hop stripped.
    const headers = args.webhookHeaders as Record<string, string>;
    expect(headers["x-github-event"]).toBe("pull_request");
    expect(headers["x-github-delivery"]).toBe("72d3162e-cc78-11e3-81ab-4c9367dc0958");
    expect(headers["x-hub-signature-256"]).toBe("sha256=abc123deadbeef");
    expect(headers["user-agent"]).toBe("GitHub-Hookshot/abc");
    expect(headers["content-type"]).toBe("application/json");
    // Hop-by-hop stripped (none of these should be in webhookHeaders).
    expect(headers).not.toHaveProperty("content-length");
    expect(headers).not.toHaveProperty("host");
    // Parsed view also set for agents that want structured access.
    expect(args.payload).toMatchObject({ action: "opened" });
  });

  test("non-JSON body still rides through with payload undefined", async () => {
    // Some upstreams (e.g. Stripe, Twilio) sign form-encoded or other
    // non-JSON payloads. The agent owns parsing; we just preserve bytes.
    const { app, publishSignalToJetStream } = createTestApp();
    const formBody = "event=charge.succeeded&id=ch_123&amount=2000";
    const res = await app.request("/workspaces/ws-1/signals/stripe-evt", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formBody,
    });
    expect(res.status).toBe(202);
    const args = publishSignalToJetStream.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(atob(args.webhookBody as string)).toBe(formBody);
    expect(args.payload).toBeUndefined();
  });

  test("envelope-shape bodies skip webhook mode (regression guard)", async () => {
    // {payload: ...} → envelope mode, NOT webhook mode. The agent SDK's
    // ctx.input.config still works the same way for CLI/MCP callers.
    const previous = process.env[INTERNAL_SIGNAL_BYPASS_TOKEN_ENV];
    process.env[INTERNAL_SIGNAL_BYPASS_TOKEN_ENV] = "test-token";
    try {
      const { app, triggerWorkspaceSignal, publishSignalToJetStream } = createTestApp();
      const res = await post(
        app,
        "/workspaces/ws-1/signals/sig-1",
        { payload: { input: "hello" }, bypassConcurrency: true },
        { [INTERNAL_SIGNAL_BYPASS_HEADER]: "test-token" },
      );
      expect(res.status).toBe(200);
      expect(triggerWorkspaceSignal).toHaveBeenCalledOnce();
      expect(publishSignalToJetStream).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env[INTERNAL_SIGNAL_BYPASS_TOKEN_ENV];
      else process.env[INTERNAL_SIGNAL_BYPASS_TOKEN_ENV] = previous;
    }
  });

  test("envelope publish does NOT carry webhookBody / webhookHeaders", async () => {
    // Non-webhook envelope callers (CLI nowait) get the same envelope as
    // before — no spurious webhookBody/webhookHeaders polluting the
    // agent's input. Locks the "webhook fields are webhook-only" contract.
    const { app, publishSignalToJetStream } = createTestApp();
    const res = await app.request("/workspaces/ws-1/signals/sig-1?nowait=true", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ payload: { hello: "world" } }),
    });
    expect(res.status).toBe(202);
    expect(publishSignalToJetStream).toHaveBeenCalledOnce();
    const args = publishSignalToJetStream.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(args).not.toHaveProperty("webhookBody");
    expect(args).not.toHaveProperty("webhookHeaders");
  });
});

describe("POST /workspaces/add validation", () => {
  test("rejects missing path", async () => {
    const { app } = createTestApp();
    const res = await post(app, "/workspaces/add", { name: "test" });
    expect(res.status).toBe(400);
  });

  test("rejects empty path", async () => {
    const { app } = createTestApp();
    const res = await post(app, "/workspaces/add", { path: "" });
    expect(res.status).toBe(400);
  });

  test("rejects empty body", async () => {
    const { app } = createTestApp();
    const res = await post(app, "/workspaces/add", {});
    expect(res.status).toBe(400);
  });
});

describe("POST /workspaces/add-batch validation", () => {
  test("rejects missing paths", async () => {
    const { app } = createTestApp();
    const res = await post(app, "/workspaces/add-batch", {});
    expect(res.status).toBe(400);
  });

  test("rejects empty paths array", async () => {
    const { app } = createTestApp();
    const res = await post(app, "/workspaces/add-batch", { paths: [] });
    expect(res.status).toBe(400);
  });

  test("rejects non-array paths", async () => {
    const { app } = createTestApp();
    const res = await post(app, "/workspaces/add-batch", { paths: "not-an-array" });
    expect(res.status).toBe(400);
  });
});

describe("POST /workspaces/:workspaceId/update validation", () => {
  test("rejects missing config", async () => {
    const { app } = createTestApp();
    const res = await post(app, "/workspaces/ws-1/update", { backup: true });
    expect(res.status).toBe(400);
  });

  test("rejects empty body", async () => {
    const { app } = createTestApp();
    const res = await post(app, "/workspaces/ws-1/update", {});
    expect(res.status).toBe(400);
  });

  test("rejects config as non-object", async () => {
    const { app } = createTestApp();
    const res = await post(app, "/workspaces/ws-1/update", { config: "not-an-object" });
    expect(res.status).toBe(400);
  });
});

// =============================================================================
// POST /workspaces/:workspaceId/update — active-session guard
// =============================================================================

function makeSession(id: string, status: string) {
  return { id, jobName: "test", signalId: "sig", startedAt: new Date(), session: { id, status } };
}

function createTestAppWithRuntime(options: { sessions?: ReturnType<typeof makeSession>[] }) {
  const { sessions = [] } = options;

  const mockWorkspace = {
    id: "ws-test",
    path: "/tmp/ws-test",
    status: "idle",
    metadata: {},
    name: "Test Workspace",
  };

  const mockWorkspaceManager = {
    find: vi.fn().mockResolvedValue(mockWorkspace),
    list: vi.fn().mockResolvedValue([]),
    getWorkspaceConfig: vi.fn().mockResolvedValue(null),
    registerWorkspace: vi.fn(),
    deleteWorkspace: vi.fn(),
  } as unknown as WorkspaceManager;

  const inflight = sessions
    .filter((s) => s.session.status === "active")
    .map((s) => ({
      sessionId: s.id,
      startedAt: s.startedAt.toISOString(),
      workspaceId: "ws-test",
      signalId: s.signalId,
    }));
  const mockSessionHistoryAdapter = {
    listInflight: vi.fn().mockResolvedValue(inflight),
  } as unknown as AppContext["sessionHistoryAdapter"];

  const mockContext: AppContext = {
    startTime: Date.now(),
    sseClients: new Map(),
    sseStreams: new Map(),
    getWorkspaceManager: () => mockWorkspaceManager,
    getAgentRegistry: vi.fn(),
    getOrCreateChatSdkInstance: vi.fn(),
    daemon: { getWorkspaceManager: () => mockWorkspaceManager } as unknown as AppContext["daemon"],
    streamRegistry: {} as AppContext["streamRegistry"],
    chatTurnRegistry: {} as AppContext["chatTurnRegistry"],
    sessionStreamRegistry: {} as AppContext["sessionStreamRegistry"],
    sessionHistoryAdapter: mockSessionHistoryAdapter,
    sessionDispatchRegistry: {} as AppContext["sessionDispatchRegistry"],
    exposeKernel: false,
    platformModels: createStubPlatformModels(),
  };

  const app = new Hono<AppVariables>();
  app.use("*", async (c, next) => {
    c.set("app", mockContext);
    c.set("userId", "test-user");
    await next();
  });
  app.route("/workspaces", workspacesRoutes);

  return { app };
}

describe("POST /workspaces/:workspaceId/update — session guard", () => {
  test("returns 409 when active session exists and force is absent", async () => {
    const { app } = createTestAppWithRuntime({ sessions: [makeSession("sess-abc", "active")] });
    const res = await post(app, "/workspaces/ws-test/update", { config: {} });
    expect(res.status).toBe(409);
  });

  test("returns 409 when active session exists and force is false", async () => {
    const { app } = createTestAppWithRuntime({ sessions: [makeSession("sess-abc", "active")] });
    const res = await post(app, "/workspaces/ws-test/update", { config: {}, force: false });
    expect(res.status).toBe(409);
  });

  test("409 response body contains expected fields", async () => {
    const { app } = createTestAppWithRuntime({
      sessions: [makeSession("sess-xyz", "active"), makeSession("sess-def", "active")],
    });
    const res = await post(app, "/workspaces/ws-test/update", { config: {} });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toMatchObject({
      success: false,
      error: expect.stringContaining("force=true"),
      activeSessionIds: expect.arrayContaining(["sess-xyz", "sess-def"]),
      hasActiveExecutions: false,
    });
  });

  test("proceeds past guard when force=true even if active sessions exist", async () => {
    const { app } = createTestAppWithRuntime({ sessions: [makeSession("sess-abc", "active")] });
    const res = await post(app, "/workspaces/ws-test/update", { config: {}, force: true });
    expect(res.status).not.toBe(409);
  });

  test("proceeds normally when no active sessions are inflight", async () => {
    const { app } = createTestAppWithRuntime({ sessions: [makeSession("sess-abc", "completed")] });
    const res = await post(app, "/workspaces/ws-test/update", { config: {} });
    expect(res.status).not.toBe(409);
  });

  test("proceeds normally when no inflight sessions are present", async () => {
    const { app } = createTestAppWithRuntime({ sessions: [] });
    const res = await post(app, "/workspaces/ws-test/update", { config: {} });
    expect(res.status).not.toBe(409);
  });
});

// =============================================================================
// formatJobName
// =============================================================================

describe("formatJobName", () => {
  const cases = [
    {
      name: "uses title when present",
      key: "daily_summary",
      job: { title: "Daily Summary" },
      expected: "Daily Summary",
    },
    { name: "formats key without title", key: "daily_summary", job: {}, expected: "Daily summary" },
    { name: "handles single word key", key: "cleanup", job: {}, expected: "Cleanup" },
    {
      name: "ignores name field in favor of title",
      key: "x",
      job: { title: "My Title", name: "mcp-name" },
      expected: "My Title",
    },
    {
      name: "falls back to formatted key when no title",
      key: "send_weekly_report",
      job: { name: "mcp-name" },
      expected: "Send weekly report",
    },
  ] as const;

  test.each(cases)("$name", ({ key, job, expected }) => {
    expect(formatJobName(key, job)).toBe(expected);
  });
});

// =============================================================================
// extractJobIntegrations
// =============================================================================

describe("extractJobIntegrations", () => {
  function makeConfig(overrides: Record<string, unknown> = {}) {
    return { version: "1.0" as const, workspace: { id: "ws-1", name: "Test" }, ...overrides };
  }

  function makeFsmJob(tools: string[][]) {
    const states: Record<string, { entry: Array<{ type: string; tools: string[] }> }> = {};
    tools.forEach((t, i) => {
      states[`step_${i}`] = { entry: [{ type: "llm", tools: t }] };
    });
    return { fsm: { states } };
  }

  test("extracts providers from MCP servers referenced by FSM action tools", () => {
    const config = makeConfig({
      tools: {
        mcp: {
          servers: {
            "github-server": { env: { TOKEN: { from: "link", provider: "github", key: "token" } } },
            "slack-server": { env: { TOKEN: { from: "link", provider: "slack", key: "token" } } },
          },
        },
      },
    });
    const job = makeFsmJob([["github-server", "slack-server"]]);
    expect(extractJobIntegrations(job, config)).toEqual(["github", "slack"]);
  });

  test("filters to only MCP servers used by the job's FSM actions", () => {
    const config = makeConfig({
      tools: {
        mcp: {
          servers: {
            "github-server": { env: { TOKEN: { from: "link", provider: "github", key: "token" } } },
            "slack-server": { env: { TOKEN: { from: "link", provider: "slack", key: "token" } } },
          },
        },
      },
    });
    const job = makeFsmJob([["github-server"]]);
    expect(extractJobIntegrations(job, config)).toEqual(["github"]);
  });

  test("collects tools across multiple FSM states", () => {
    const config = makeConfig({
      tools: {
        mcp: {
          servers: {
            "github-server": { env: { TOKEN: { from: "link", provider: "github", key: "token" } } },
            "slack-server": { env: { TOKEN: { from: "link", provider: "slack", key: "token" } } },
          },
        },
      },
    });
    const job = makeFsmJob([["github-server"], ["slack-server"]]);
    expect(extractJobIntegrations(job, config)).toEqual(["github", "slack"]);
  });

  test("deduplicates providers", () => {
    const config = makeConfig({
      tools: {
        mcp: {
          servers: {
            server1: { env: { A: { from: "link", provider: "github", key: "a" } } },
            server2: { env: { B: { from: "link", provider: "github", key: "b" } } },
          },
        },
      },
    });
    const job = makeFsmJob([["server1", "server2"]]);
    expect(extractJobIntegrations(job, config)).toEqual(["github"]);
  });

  test("returns empty array when job has no FSM", () => {
    const config = makeConfig({
      tools: {
        mcp: {
          servers: {
            "github-server": { env: { TOKEN: { from: "link", provider: "github", key: "token" } } },
          },
        },
      },
    });
    expect(extractJobIntegrations({}, config)).toEqual([]);
  });

  test("returns empty array when FSM actions have no tools", () => {
    const config = makeConfig();
    const job = { fsm: { states: { step_0: { entry: [{ type: "llm" }] } } } };
    expect(extractJobIntegrations(job, config)).toEqual([]);
  });

  test("extracts providers from bundled agent actions", () => {
    const config = makeConfig();
    const job = { fsm: { states: { step_0: { entry: [{ type: "agent", agentId: "slack" }] } } } };
    expect(extractJobIntegrations(job, config)).toEqual(["slack"]);
  });

  test("combines providers from LLM tools and bundled agents", () => {
    const config = makeConfig({
      tools: {
        mcp: {
          servers: {
            "google-sheets": { env: { TOKEN: { from: "link", provider: "google", key: "token" } } },
          },
        },
      },
    });
    const job = {
      fsm: {
        states: {
          step_0: { entry: [{ type: "agent", agentId: "slack" }] },
          step_1: { entry: [{ type: "llm", tools: ["google-sheets"] }] },
        },
      },
    };
    expect(extractJobIntegrations(job, config)).toEqual(["google", "slack"]);
  });

  test("ignores unknown agent IDs", () => {
    const config = makeConfig();
    const job = {
      fsm: { states: { step_0: { entry: [{ type: "agent", agentId: "nonexistent" }] } } },
    };
    expect(extractJobIntegrations(job, config)).toEqual([]);
  });
});

// =============================================================================
// GET /workspaces/:workspaceId/jobs
// =============================================================================

describe("GET /workspaces/:workspaceId/jobs", () => {
  function createJobsTestApp(options: { config?: Record<string, unknown> | null }) {
    const { config = null } = options;

    const mockWorkspaceManager = {
      find: vi.fn().mockResolvedValue(null),
      list: vi.fn().mockResolvedValue([]),
      getWorkspaceConfig: vi.fn().mockResolvedValue(config),
      registerWorkspace: vi.fn(),
      deleteWorkspace: vi.fn(),
    } as unknown as WorkspaceManager;

    const mockDaemon = { getWorkspaceManager: () => mockWorkspaceManager, runtimes: new Map() };

    const mockContext: AppContext = {
      startTime: Date.now(),
      sseClients: new Map(),
      sseStreams: new Map(),
      getWorkspaceManager: () => mockWorkspaceManager,
      getAgentRegistry: vi.fn(),
      getOrCreateChatSdkInstance: vi.fn(),
      daemon: mockDaemon as unknown as AppContext["daemon"],
      streamRegistry: {} as AppContext["streamRegistry"],
      chatTurnRegistry: {} as AppContext["chatTurnRegistry"],
      sessionStreamRegistry: {} as AppContext["sessionStreamRegistry"],
      sessionHistoryAdapter: {} as AppContext["sessionHistoryAdapter"],
      sessionDispatchRegistry: {} as AppContext["sessionDispatchRegistry"],
      exposeKernel: false,
      platformModels: createStubPlatformModels(),
    };

    const app = new Hono<AppVariables>();
    app.use("*", async (c, next) => {
      c.set("app", mockContext);
      c.set("userId", "test-user");
      await next();
    });
    app.route("/workspaces", workspacesRoutes);

    return { app, mockWorkspaceManager };
  }

  test("returns enriched job data with title as name", async () => {
    const { app } = createJobsTestApp({
      config: {
        workspace: {
          version: "1.0",
          workspace: { id: "ws-1", name: "Test" },
          jobs: {
            daily_summary: {
              title: "Daily Summary",
              description: "Summarizes the day",
              execution: { agents: ["agent-1"], strategy: "sequential" },
            },
          },
        },
      },
    });

    const res = await app.request("/workspaces/ws-1/jobs");
    expect(res.status).toBe(200);

    const body = JSON.parse(await res.text());
    expect(body).toEqual([
      {
        id: "daily_summary",
        name: "Daily Summary",
        description: "Summarizes the day",
        integrations: [],
      },
    ]);
  });

  test("formats job key when no title", async () => {
    const { app } = createJobsTestApp({
      config: {
        workspace: {
          version: "1.0",
          workspace: { id: "ws-1", name: "Test" },
          jobs: {
            send_weekly_report: {
              description: "Weekly report",
              execution: { agents: ["agent-1"], strategy: "sequential" },
            },
          },
        },
      },
    });

    const res = await app.request("/workspaces/ws-1/jobs");
    const body = JSON.parse(await res.text()) as Record<string, unknown>[];
    expect(body[0]).toMatchObject({ id: "send_weekly_report", name: "Send weekly report" });
  });

  test("extracts integrations from MCP credentials per FSM job", async () => {
    const { app } = createJobsTestApp({
      config: {
        workspace: {
          version: "1.0",
          workspace: { id: "ws-1", name: "Test" },
          tools: {
            mcp: {
              servers: {
                "github-server": {
                  command: "npx",
                  env: { GITHUB_TOKEN: { from: "link", provider: "github", key: "access_token" } },
                },
                "slack-server": {
                  command: "npx",
                  env: { SLACK_TOKEN: { from: "link", provider: "slack", key: "bot_token" } },
                },
              },
            },
          },
          jobs: {
            sync_issues: {
              title: "Sync Issues",
              fsm: { states: { step_0: { entry: [{ type: "llm", tools: ["github-server"] }] } } },
            },
            post_updates: {
              title: "Post Updates",
              fsm: { states: { step_0: { entry: [{ type: "llm", tools: ["slack-server"] }] } } },
            },
          },
        },
      },
    });

    const res = await app.request("/workspaces/ws-1/jobs");
    const body = JSON.parse(await res.text()) as Record<string, unknown>[];

    const syncJob = body.find((j: Record<string, unknown>) => j.id === "sync_issues");
    const postJob = body.find((j: Record<string, unknown>) => j.id === "post_updates");
    expect(syncJob?.integrations).toEqual(["github"]);
    expect(postJob?.integrations).toEqual(["slack"]);
  });

  test("returns 404 when workspace config not found", async () => {
    const { app } = createJobsTestApp({ config: null });

    const res = await app.request("/workspaces/ws-1/jobs");
    expect(res.status).toBe(404);

    const body = JSON.parse(await res.text());
    expect(body).toEqual({ error: "Workspace not found: ws-1" });
  });

  test("returns empty array when no jobs configured", async () => {
    const { app } = createJobsTestApp({
      config: { workspace: { version: "1.0", workspace: { id: "ws-1", name: "Test" } } },
    });

    const res = await app.request("/workspaces/ws-1/jobs");
    expect(res.status).toBe(200);

    const body = JSON.parse(await res.text());
    expect(body).toEqual([]);
  });
});

// =============================================================================
// Pending revision endpoints
// =============================================================================

describe("GET /workspaces/:workspaceId/pending-revision", () => {
  test("returns null when no pending revision", async () => {
    const { app } = createTestApp();
    const res = await app.request("/workspaces/ws-1/pending-revision");
    // Workspace not found (mock returns null)
    expect(res.status).toBe(404);
  });
});

describe("POST /workspaces/:workspaceId/pending-revision/approve", () => {
  test("returns 404 when workspace not found", async () => {
    const { app } = createTestApp();
    const res = await app.request("/workspaces/ws-1/pending-revision/approve", { method: "POST" });
    expect(res.status).toBe(404);
  });
});

describe("POST /workspaces/:workspaceId/pending-revision/reject", () => {
  test("returns 404 when workspace not found", async () => {
    const { app } = createTestApp();
    const res = await app.request("/workspaces/ws-1/pending-revision/reject", { method: "POST" });
    expect(res.status).toBe(404);
  });
});

// =============================================================================
// injectBundledAgentRefs
// =============================================================================

describe("injectBundledAgentRefs", () => {
  function makeConfig(agents?: WorkspaceConfig["agents"]): WorkspaceConfig {
    return { version: "1.0" as const, workspace: { id: "ws-1", name: "Test" }, agents };
  }

  test("returns config unchanged when agents is undefined", () => {
    const config = makeConfig(undefined);
    const result = injectBundledAgentRefs(config);
    expect(result).toBe(config);
  });

  test("skips non-atlas agent types", () => {
    const config = makeConfig({
      "my-llm": {
        type: "llm",
        description: "Custom LLM agent",
        config: {
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          prompt: "Do things",
          temperature: 0.3,
        },
      },
    });
    const result = injectBundledAgentRefs(config);
    expect(result).toBe(config);
  });

  test("skips atlas agent with unknown agent id", () => {
    const config = makeConfig({
      "my-agent": {
        type: "atlas",
        agent: "nonexistent-agent-id",
        description: "Unknown agent",
        prompt: "Do things",
      },
    });
    const result = injectBundledAgentRefs(config);
    expect(result).toBe(config);
  });

  test("injects missing link credential refs for bundled atlas agent", () => {
    const config = makeConfig({
      communicator: {
        type: "atlas",
        agent: "slack",
        description: "Slack communicator",
        prompt: "Talk on Slack",
      },
    });
    const result = injectBundledAgentRefs(config);

    expect(result).not.toBe(config);
    const agent = result.agents?.communicator;
    if (!agent || agent.type !== "atlas") throw new Error("Expected atlas agent");
    expect(agent.env).toMatchObject({
      SLACK_MCP_XOXP_TOKEN: { from: "link", provider: "slack", key: "access_token" },
    });
  });

  test("does not overwrite existing env refs", () => {
    const existingRef = { from: "link" as const, provider: "slack", key: "custom_token" };
    const config = makeConfig({
      communicator: {
        type: "atlas",
        agent: "slack",
        description: "Slack communicator",
        prompt: "Talk on Slack",
        env: { SLACK_MCP_XOXP_TOKEN: existingRef },
      },
    });
    const result = injectBundledAgentRefs(config);

    // No injection needed — all refs present — returns same object
    expect(result).toBe(config);
  });

  test("returns config unchanged when all refs already present", () => {
    const config = makeConfig({
      communicator: {
        type: "atlas",
        agent: "slack",
        description: "Slack communicator",
        prompt: "Talk on Slack",
        env: { SLACK_MCP_XOXP_TOKEN: { from: "link", provider: "slack", key: "access_token" } },
      },
    });
    const result = injectBundledAgentRefs(config);
    expect(result).toBe(config);
  });
});

// =============================================================================
// POST /workspaces/:workspaceId/signals/:signalId — client-abort cancellation wiring
// =============================================================================
//
// The cascade-layer cancellation semantics live in `cascade-stream.test.ts`.
// These tests lock down the route-level wiring that publishes the
// `signals.cancel.<correlationId>` frame when the HTTP client aborts. A
// regression here is otherwise silent: TypeScript would compile, cascade
// tests would stay green, and the only observable failure mode is cascades
// running to completion (and firing side-effect tools) after the caller has
// gone away.
//
// The test uses two separate NATS connections against one server: the route
// publishes the cancel frame on the daemon's connection, the test subscribes
// on its own. Separate connections avoid duplicate-delivery surprises if the
// route ever grows internal `signals.cancel.*` subscribers.

describe("POST /workspaces/:workspaceId/signals/:signalId — client-abort cancellation wiring", () => {
  let server: TestNatsServer;
  let daemonNc: NatsConnection;
  let testNc: NatsConnection;

  beforeAll(async () => {
    server = await startNatsTestServer();
    daemonNc = await connect({ servers: server.url });
    testNc = await connect({ servers: server.url });
  }, 30_000);

  afterAll(async () => {
    await testNc.drain();
    await daemonNc.drain();
    await server.stop();
  });

  function createAbortTestApp() {
    const publishSignalToJetStream = vi.fn().mockResolvedValue({ seq: 1 });

    const mockWorkspaceManager = {
      find: vi.fn().mockResolvedValue({ id: "ws-1", path: "/tmp/ws-1", name: "Test" }),
      list: vi.fn().mockResolvedValue([]),
      getWorkspaceConfig: vi.fn().mockResolvedValue(null),
      registerWorkspace: vi.fn(),
      deleteWorkspace: vi.fn(),
    } as unknown as WorkspaceManager;

    const mockContext: AppContext = {
      startTime: Date.now(),
      sseClients: new Map(),
      sseStreams: new Map(),
      getWorkspaceManager: () => mockWorkspaceManager,
      getAgentRegistry: vi.fn(),
      getOrCreateChatSdkInstance: vi.fn(),
      daemon: {
        getWorkspaceManager: () => mockWorkspaceManager,
        getNatsConnection: () => daemonNc,
        publishSignalToJetStream,
        triggerWorkspaceSignal: vi.fn(),
      } as unknown as AppContext["daemon"],
      streamRegistry: {} as AppContext["streamRegistry"],
      chatTurnRegistry: {} as AppContext["chatTurnRegistry"],
      sessionStreamRegistry: {} as AppContext["sessionStreamRegistry"],
      sessionHistoryAdapter: {} as AppContext["sessionHistoryAdapter"],
      sessionDispatchRegistry: {} as AppContext["sessionDispatchRegistry"],
      exposeKernel: false,
      platformModels: createStubPlatformModels(),
    };

    const app = new Hono<AppVariables>();
    app.use("*", async (c, next) => {
      c.set("app", mockContext);
      c.set("userId", "test-user");
      await next();
    });
    app.route("/workspaces", workspacesRoutes);

    return { app };
  }

  // Subscribe to the wildcard cancel subject and wait for the first frame.
  // `*` matches exactly one token, locking down the assumption that
  // correlationId is a single UUID without dots — if that ever changes the
  // test fails loudly. `nc.flush()` after subscribe waits for the server to
  // register interest before the test publishes anything that should hit it.
  async function awaitFirstCancelFrame(timeoutMs: number) {
    const sub = testNc.subscribe("signals.cancel.*");
    await testNc.flush();
    const iter = sub[Symbol.asyncIterator]();
    try {
      const winner = await Promise.race([
        iter.next(),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`no cancel frame received within ${timeoutMs}ms`)),
            timeoutMs,
          ),
        ),
      ]);
      if (winner.done || !winner.value) {
        throw new Error("cancel subscription closed without a frame");
      }
      return winner.value;
    } finally {
      sub.unsubscribe();
    }
  }

  const CORRELATION_ID_RE = /^signals\.cancel\.[0-9a-f-]{36}$/;

  test("JSON variant: aborting before the response arrives publishes a cancel frame", async () => {
    const { app } = createAbortTestApp();
    const framePromise = awaitFirstCancelFrame(2000);

    const ac = new AbortController();
    const reqPromise = Promise.resolve(
      app.request("/workspaces/ws-1/signals/sig-1", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ payload: {} }),
        signal: ac.signal,
      }),
    ).catch(() => undefined);

    // Yield long enough for the route to attach its abort listener and park
    // in awaitSignalCompletion. The stub on publishSignalToJetStream resolves
    // immediately; no response is ever published on signals.responses.<id>,
    // so the route stays parked until the abort fires.
    await new Promise((r) => setTimeout(r, 50));
    ac.abort();

    const msg = await framePromise;
    expect(msg.subject).toMatch(CORRELATION_ID_RE);
    const body = JSON.parse(new TextDecoder().decode(msg.data)) as {
      reason: string;
      requestedAt: string;
    };
    expect(body.reason).toBe("Client disconnected");
    expect(body.requestedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    await reqPromise;
  });

  // The SSE branch has two cancel paths in production: the `onClientAbort`
  // listener (exercised here) and the `ReadableStream.cancel()` callback
  // (not exercised — Hono's `app.request()` doesn't drive the response
  // stream's cancel callback, and in real production an HTTP-level client
  // abort fires `onClientAbort` first, so `cancel()` is defense-in-depth).
  test("SSE variant: aborting before data-session-start publishes a cancel frame", async () => {
    const { app } = createAbortTestApp();
    const framePromise = awaitFirstCancelFrame(2000);

    const ac = new AbortController();
    const reqPromise = Promise.resolve(
      app.request("/workspaces/ws-1/signals/sig-1", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify({ payload: {} }),
        signal: ac.signal,
      }),
    ).catch(() => undefined);

    // Same 50ms invariant as the JSON test: yield long enough for the route
    // to attach its abort listener before the abort fires.
    await new Promise((r) => setTimeout(r, 50));
    ac.abort();

    const msg = await framePromise;
    expect(msg.subject).toMatch(CORRELATION_ID_RE);
    const body = JSON.parse(new TextDecoder().decode(msg.data)) as {
      reason: string;
      requestedAt: string;
    };
    expect(body.reason).toBe("Client disconnected");
    expect(body.requestedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    await reqPromise;
  });
});
