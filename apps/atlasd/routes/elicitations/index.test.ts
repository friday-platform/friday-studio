/**
 * Tests for the elicitation HTTP routes.
 *
 * The JetStream-backed storage facade (`ElicitationStorage` from
 * `@atlas/core`) is too heavy to spin up in unit tests, so we mock the
 * `@atlas/core/elicitations` module wholesale and assert the routes
 * shape requests/responses correctly + return the right HTTP statuses.
 *
 * Live JetStream coverage lives in the adapter's own `*.test.ts`.
 */

import { fail, success } from "@atlas/utils";
import { Hono } from "hono";
import { beforeEach, describe, expect, test, vi } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mock for the storage facade
// ---------------------------------------------------------------------------

const { mockElicitationStorage, mockToolAccessGrants } = vi.hoisted(() => ({
  mockElicitationStorage: {
    create: vi.fn(),
    get: vi.fn(),
    list: vi.fn(),
    answer: vi.fn(),
    decline: vi.fn(),
  },
  mockToolAccessGrants: { grantAlways: vi.fn() },
}));

vi.mock("@atlas/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@atlas/core")>();
  return {
    ...actual,
    ElicitationStorage: mockElicitationStorage,
    ToolAccessGrants: mockToolAccessGrants,
  };
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
  mockToolAccessGrants.grantAlways.mockResolvedValue(
    success({
      workspaceId: "ws_1",
      toolName: "send_email",
      scope: "workspace",
      grantedAt: "2026-05-05T00:30:00.000Z",
    }),
  );
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

  test("allow_always on a tool-allowlist elicitation persists a workspace tool grant", async () => {
    const pending = makeElicitation({
      kind: "tool-allowlist",
      pendingTool: { name: "send_email", args: {} },
    });
    const answered = makeElicitation({
      kind: "tool-allowlist",
      pendingTool: { name: "send_email", args: {} },
      status: "answered",
      answer: {
        value: "allow_always",
        answeredBy: "user@x",
        answeredAt: "2026-05-05T00:30:00.000Z",
      },
    });
    mockElicitationStorage.get.mockResolvedValueOnce(success(pending));
    mockElicitationStorage.answer.mockResolvedValueOnce(success(answered));

    const res = await createTestApp().request("/elc_1/answer", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: "allow_always", answeredBy: "user@x" }),
    });

    expect(res.status).toBe(200);
    expect(mockToolAccessGrants.grantAlways).toHaveBeenCalledWith({
      workspaceId: "ws_1",
      toolName: "send_email",
      sourceElicitationId: "elc_1",
      grantedBy: "user@x",
    });
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
