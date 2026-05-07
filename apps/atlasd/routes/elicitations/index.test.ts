/**
 * Tests for the elicitation HTTP routes (Phase 12.B).
 *
 * The JetStream-backed storage facade (`ElicitationStorage` from
 * `@atlas/core`) is too heavy to spin up in unit tests, so we mock the
 * `@atlas/core/elicitations` module wholesale and assert the routes
 * shape requests/responses correctly + return the right HTTP statuses.
 *
 * Live JetStream coverage lives in the adapter's own `*.test.ts` (and a
 * future integration test once we have a NATS test fixture mounted at
 * the daemon level).
 */

import { fail, success } from "@atlas/utils";
import { Hono } from "hono";
import type { NatsConnection } from "nats";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { getTestNc } from "../../../../vitest.setup.ts";

// ---------------------------------------------------------------------------
// Hoisted mock for the storage facade
// ---------------------------------------------------------------------------

const { mockElicitationStorage } = vi.hoisted(() => ({
  mockElicitationStorage: {
    create: vi.fn(),
    get: vi.fn(),
    list: vi.fn(),
    answer: vi.fn(),
    decline: vi.fn(),
  },
}));

vi.mock("@atlas/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@atlas/core")>();
  return { ...actual, ElicitationStorage: mockElicitationStorage };
});

// Import AFTER the mock so the route binds to the mocked facade.
import { elicitationApp as rawElicitationApp } from "./index.ts";

// ---------------------------------------------------------------------------
// Test app — wires the routes under a Hono app with a mock context.
// We don't exercise `/stream` here (would require a real NATS), so the
// daemon getter never runs.
// ---------------------------------------------------------------------------

type MockContext = { daemon: { getNatsConnection: () => null } };

function createTestApp() {
  const app = new Hono<{ Variables: { app: MockContext } }>();
  app.use("*", async (c, next) => {
    c.set("app", { daemon: { getNatsConnection: () => null } });
    await next();
  });
  app.route("/", rawElicitationApp);
  return app;
}

function makeElicitation(overrides: Record<string, unknown> = {}) {
  return {
    id: "elc_1",
    workspaceId: "ws_1",
    sessionId: "sess_1",
    kind: "open-question" as const,
    question: "Continue?",
    createdAt: "2026-05-05T00:00:00.000Z",
    expiresAt: "2026-05-05T01:00:00.000Z",
    status: "pending" as const,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// GET /
// ---------------------------------------------------------------------------

describe("GET /", () => {
  test("returns empty list when none exist", async () => {
    mockElicitationStorage.list.mockResolvedValueOnce(success([]));
    const res = await createTestApp().request("/");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ elicitations: [], count: 0 });
  });

  test("forwards filter params to the storage facade", async () => {
    mockElicitationStorage.list.mockResolvedValueOnce(success([]));
    await createTestApp().request("/?workspaceId=ws_1&sessionId=sess_1&status=pending");
    expect(mockElicitationStorage.list).toHaveBeenCalledWith({
      workspaceId: "ws_1",
      sessionId: "sess_1",
      status: "pending",
    });
  });

  test("kind filter is applied client-side after storage list", async () => {
    const open = makeElicitation({ id: "elc_open", kind: "open-question" });
    const refresh = makeElicitation({ id: "elc_auth", kind: "auth-refresh" });
    mockElicitationStorage.list.mockResolvedValueOnce(success([open, refresh]));
    const res = await createTestApp().request("/?kind=auth-refresh");
    const body = (await res.json()) as { count: number; elicitations: { id: string }[] };
    expect(body.count).toBe(1);
    expect(body.elicitations[0]?.id).toBe("elc_auth");
  });

  test("rejects an unknown status value (zod validator)", async () => {
    const res = await createTestApp().request("/?status=garbage");
    expect(res.status).toBe(400);
  });

  test("propagates storage errors as 500", async () => {
    mockElicitationStorage.list.mockResolvedValueOnce(fail("kv broken"));
    const res = await createTestApp().request("/");
    expect(res.status).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// GET /:id
// ---------------------------------------------------------------------------

describe("GET /:id", () => {
  test("returns the elicitation when it exists", async () => {
    const e = makeElicitation();
    mockElicitationStorage.get.mockResolvedValueOnce(success(e));
    const res = await createTestApp().request("/elc_1");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(e);
  });

  test("404s when not found", async () => {
    mockElicitationStorage.get.mockResolvedValueOnce(success(null));
    const res = await createTestApp().request("/elc_missing");
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// POST /:id/answer
// ---------------------------------------------------------------------------

describe("POST /:id/answer", () => {
  test("404s on unknown id", async () => {
    mockElicitationStorage.get.mockResolvedValueOnce(success(null));
    const res = await createTestApp().request("/elc_missing/answer", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: "allow-once" }),
    });
    expect(res.status).toBe(404);
    expect(mockElicitationStorage.answer).not.toHaveBeenCalled();
  });

  test("happy path → status flips to answered", async () => {
    const pending = makeElicitation();
    const answered = makeElicitation({
      status: "answered",
      answer: {
        value: "allow-once",
        note: "from web",
        answeredBy: "user@x",
        answeredAt: "2026-05-05T00:30:00.000Z",
      },
    });
    mockElicitationStorage.get.mockResolvedValueOnce(success(pending));
    mockElicitationStorage.answer.mockResolvedValueOnce(success(answered));

    const res = await createTestApp().request("/elc_1/answer", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: "allow-once", note: "from web", answeredBy: "user@x" }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; answer: { value: string } };
    expect(body.status).toBe("answered");
    expect(body.answer.value).toBe("allow-once");

    // Server should have filled `answeredAt` (ISO string).
    const callArg = mockElicitationStorage.answer.mock.calls[0]?.[0] as
      | { id: string; answer: { answeredAt: string; value: string } }
      | undefined;
    expect(callArg?.answer.answeredAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(callArg?.answer.value).toBe("allow-once");
  });

  test("rejects body missing `value`", async () => {
    const res = await createTestApp().request("/elc_1/answer", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ note: "no value field" }),
    });
    expect(res.status).toBe(400);
    expect(mockElicitationStorage.answer).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// POST /:id/decline
// ---------------------------------------------------------------------------

describe("POST /:id/decline", () => {
  test("404s on unknown id", async () => {
    mockElicitationStorage.get.mockResolvedValueOnce(success(null));
    const res = await createTestApp().request("/elc_missing/decline", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
    expect(mockElicitationStorage.decline).not.toHaveBeenCalled();
  });

  test("happy path → status flips to declined", async () => {
    const pending = makeElicitation();
    const declined = makeElicitation({
      status: "declined",
      answer: { value: "declined", note: "user said no", answeredAt: "2026-05-05T00:30:00.000Z" },
    });
    mockElicitationStorage.get.mockResolvedValueOnce(success(pending));
    mockElicitationStorage.decline.mockResolvedValueOnce(success(declined));

    const res = await createTestApp().request("/elc_1/decline", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ note: "user said no" }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("declined");
    expect(mockElicitationStorage.decline).toHaveBeenCalledWith({
      id: "elc_1",
      note: "user said no",
    });
  });

  test("works without a note", async () => {
    const pending = makeElicitation();
    const declined = makeElicitation({
      status: "declined",
      answer: { value: "declined", answeredAt: "2026-05-05T00:30:00.000Z" },
    });
    mockElicitationStorage.get.mockResolvedValueOnce(success(pending));
    mockElicitationStorage.decline.mockResolvedValueOnce(success(declined));

    const res = await createTestApp().request("/elc_1/decline", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(200);
    expect(mockElicitationStorage.decline).toHaveBeenCalledWith({ id: "elc_1" });
  });

  test("rejects a non-string note", async () => {
    const res = await createTestApp().request("/elc_1/decline", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ note: 42 }),
    });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// GET /stream — SSE feed (H5)
//
// Drives a real NATS connection (the worker-shared fixture from
// vitest.setup.ts) so the subscribe → flush → for-await teardown is the
// real code path. Each test uses a UUID workspaceId so concurrent suites
// can't pollute each other's subject space.
// ---------------------------------------------------------------------------

/**
 * Minimal mock daemon context that hands the route a live NATS
 * connection. The real `daemon.getNatsConnection()` returns the daemon's
 * shared connection; we substitute the worker's test-server connection.
 */
function createSseTestApp(nc: NatsConnection) {
  type Ctx = { daemon: { getNatsConnection: () => NatsConnection } };
  const app = new Hono<{ Variables: { app: Ctx } }>();
  app.use("*", async (c, next) => {
    c.set("app", { daemon: { getNatsConnection: () => nc } });
    await next();
  });
  app.route("/", rawElicitationApp);
  return app;
}

/**
 * Read text frames from the SSE response body until `predicate(buf)`
 * returns truthy or `timeoutMs` elapses. The response body is a
 * `ReadableStream<Uint8Array>`; we accumulate decoded text in `buf`.
 *
 * Returns the accumulated text on resolve; throws on timeout.
 */
async function readUntil(
  res: Response,
  predicate: (buf: string) => boolean,
  timeoutMs = 2000,
): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) throw new Error("response has no body");
  const decoder = new TextDecoder();
  let buf = "";
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    const next = reader.read();
    const tick = new Promise<{ done: true; value: undefined }>((r) =>
      setTimeout(() => r({ done: true, value: undefined }), remaining),
    );
    const chunk = (await Promise.race([next, tick])) as ReadableStreamReadResult<Uint8Array>;
    if (chunk.done) break;
    buf += decoder.decode(chunk.value, { stream: true });
    if (predicate(buf)) return buf;
  }
  throw new Error(`readUntil timed out after ${timeoutMs}ms; buf=${JSON.stringify(buf)}`);
}

/**
 * Snapshot the connection's active subscription count. The nats client
 * doesn't expose this in the public API, so we reach into the protocol
 * handler. This is the only reliable way to assert "the SSE handler
 * unsubscribed on abort" — `nc.stats()` only tracks message counts.
 */
function activeSubs(nc: NatsConnection): number {
  return (
    nc as unknown as { protocol: { subscriptions: { size: () => number } } }
  ).protocol.subscriptions.size();
}

describe("GET /stream — SSE", () => {
  let nc: NatsConnection;

  beforeEach(() => {
    nc = getTestNc();
  });

  test("503 when NATS is not ready", async () => {
    // Mirror createTestApp's null-NATS context to exercise the early-return path.
    const app = new Hono<{ Variables: { app: { daemon: { getNatsConnection: () => null } } } }>();
    app.use("*", async (c, next) => {
      c.set("app", { daemon: { getNatsConnection: () => null } });
      await next();
    });
    app.route("/", rawElicitationApp);

    const res = await app.request("/stream");
    expect(res.status).toBe(503);
  });

  test("subscribe → publish envelope → SSE frame received with correct framing", async () => {
    const wsId = `ws-sse-${crypto.randomUUID().slice(0, 8)}`;
    const app = createSseTestApp(nc);

    const controller = new AbortController();
    try {
      const res = await app.request(`/stream?workspaceId=${wsId}`, { signal: controller.signal });
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("text/event-stream");
      expect(res.headers.get("Cache-Control")).toBe("no-cache");

      // Handler awaits `nc.flush()` before returning, so by the time we have
      // `res` the broker has registered the subscription. A publish here is
      // guaranteed to be delivered.
      const envelope = { id: "elc_sse_1", workspaceId: wsId, status: "pending", question: "ok?" };
      nc.publish(`elicitations.${wsId}.sess.elc_sse_1`, JSON.stringify(envelope));

      const buf = await readUntil(res, (b) => b.includes("elc_sse_1"));

      // Well-formed SSE frame: `data: <json>\n\n`. No `event:` field is
      // emitted by this handler (default event type "message"), and there
      // should be exactly one frame for our one publish.
      const frames = buf.split("\n\n").filter((f) => f.length > 0);
      expect(frames.length).toBe(1);
      expect(frames[0]).toBe(`data: ${JSON.stringify(envelope)}`);
    } finally {
      controller.abort();
    }
  });

  test("abort → handler unsubscribes from NATS (no leaked subscription)", async () => {
    const wsId = `ws-abort-${crypto.randomUUID().slice(0, 8)}`;
    const app = createSseTestApp(nc);
    const baseline = activeSubs(nc);

    const controller = new AbortController();
    const res = await app.request(`/stream?workspaceId=${wsId}`, { signal: controller.signal });
    expect(res.status).toBe(200);

    // Subscription should now be live.
    expect(activeSubs(nc)).toBe(baseline + 1);

    // Aborting the request signal should fire the abort listener inside the
    // ReadableStream `start()` and call `sub.unsubscribe()` + `controller.close()`.
    controller.abort();

    // The handler's abort listener runs synchronously, but the body reader
    // also needs to drain — give the event loop a tick or two for the
    // unsubscribe to land in the protocol's subscription map.
    await new Promise((r) => setTimeout(r, 50));

    expect(activeSubs(nc)).toBe(baseline);
  });

  test("late subscriber does NOT replay envelopes published before subscribe (Core NATS, no JetStream consumer)", async () => {
    // This documents a real limitation of the SSE handler: it uses a Core
    // NATS subscribe (`nc.subscribe`), not a JetStream pull/push consumer
    // bound to the ELICITATIONS stream. Pre-subscribe envelopes on the wire
    // are dropped — only events published AFTER the handshake reach the
    // client. Per the review (H2 / N3), accepting this means reconnects /
    // late-attach flows lose history; the activity page must reconcile via
    // the REST list endpoint, not assume SSE replay.
    const wsId = `ws-late-${crypto.randomUUID().slice(0, 8)}`;
    const app = createSseTestApp(nc);

    // Publish BEFORE any subscriber exists. With Core NATS this drops the
    // message at the broker (no interest, no delivery).
    nc.publish(
      `elicitations.${wsId}.sess.elc_pre`,
      JSON.stringify({ id: "elc_pre", workspaceId: wsId, status: "pending", question: "early?" }),
    );
    await nc.flush();

    const controller = new AbortController();
    try {
      const res = await app.request(`/stream?workspaceId=${wsId}`, { signal: controller.signal });
      expect(res.status).toBe(200);

      // Now publish a fresh envelope — that one MUST arrive.
      const live = { id: "elc_live", workspaceId: wsId, status: "pending", question: "now?" };
      nc.publish(`elicitations.${wsId}.sess.elc_live`, JSON.stringify(live));

      const buf = await readUntil(res, (b) => b.includes("elc_live"));
      expect(buf).toContain("elc_live");
      // The pre-subscribe envelope must NOT be replayed.
      expect(buf).not.toContain("elc_pre");
    } finally {
      controller.abort();
    }
  });

  test("multiple envelopes are emitted as distinct, well-formed frames in order", async () => {
    const wsId = `ws-flush-${crypto.randomUUID().slice(0, 8)}`;
    const app = createSseTestApp(nc);

    const controller = new AbortController();
    try {
      const res = await app.request(`/stream?workspaceId=${wsId}`, { signal: controller.signal });
      expect(res.status).toBe(200);

      const envs = [
        { id: "elc_a", workspaceId: wsId, status: "pending", question: "a?" },
        { id: "elc_b", workspaceId: wsId, status: "pending", question: "b?" },
        { id: "elc_c", workspaceId: wsId, status: "pending", question: "c?" },
      ];
      for (const e of envs) {
        nc.publish(`elicitations.${wsId}.sess.${e.id}`, JSON.stringify(e));
      }

      const buf = await readUntil(res, (b) => b.includes("elc_c"));
      const frames = buf.split("\n\n").filter((f) => f.length > 0);
      // Each publish becomes exactly one frame — no duplicates from the
      // initial-flush + per-envelope-flush handshake.
      expect(frames.length).toBe(3);
      expect(frames[0]).toBe(`data: ${JSON.stringify(envs[0])}`);
      expect(frames[1]).toBe(`data: ${JSON.stringify(envs[1])}`);
      expect(frames[2]).toBe(`data: ${JSON.stringify(envs[2])}`);
    } finally {
      controller.abort();
    }
  });
});
