/**
 * Integration tests for session history v2 routes.
 *
 * Tests the JSON detail endpoint (GET /:id) and list endpoint (GET /).
 * Uses real LocalSessionHistoryAdapter with temp directories and
 * real SessionStreamRegistry for active session testing.
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildSessionView,
  type SessionHistoryAdapter,
  type SessionStartEvent,
  type SessionStreamEvent,
  type SessionSummary,
  type SessionSummaryEvent,
  type SessionView,
  type StepCompleteEvent,
  type StepStartEvent,
} from "@atlas/core";
import { Hono } from "hono";
import type { NatsConnection } from "nats";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { AppContext, AppVariables } from "../../src/factory.ts";
import { SessionStreamRegistry } from "../../src/session-stream-registry.ts";
import { sessionsRoutes } from "./index.ts";

// Mock getFridayHome so the v1 file check uses our temp directory.
const mockAtlasHome = vi.hoisted(() => ({ value: "" }));
vi.mock("@atlas/utils/paths.server", () => ({ getFridayHome: () => mockAtlasHome.value }));

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
    // listByUser feeds the accessible-workspace filter on the
    // unscoped `GET /` sessions list. Seed the wsIds the fixtures use
    // so the listing doesn't drop them.
    listByUser: vi.fn().mockResolvedValue({
      ok: true,
      data: [
        { userId: "test-user", wsId: "ws-1", role: "owner", addedAt: "2026-05-11T00:00:00.000Z" },
        { userId: "test-user", wsId: "ws-2", role: "owner", addedAt: "2026-05-11T00:00:00.000Z" },
      ],
    }),
    listByWorkspace: vi.fn().mockResolvedValue({ ok: true, data: [] }),
    put: vi.fn().mockResolvedValue({ ok: true, data: null }),
    putIfAbsent: vi.fn().mockResolvedValue({ ok: true, data: null }),
    delete: vi.fn().mockResolvedValue({ ok: true, data: undefined }),
  },
  ensureWorkspaceMembersKVBucket: vi.fn(),
  initWorkspaceMemberStorage: vi.fn(),
  resetWorkspaceMemberStorageForTests: vi.fn(),
}));

/**
 * In-memory `SessionHistoryAdapter` for tests. Replaces the deleted
 * `LocalSessionHistoryAdapter` (filesystem-JSONL) with a Map-backed
 * impl so route tests don't depend on disk state and don't need the
 * NATS test fixture either. Mirrors the public `SessionHistoryAdapter`
 * contract exactly.
 */
class InMemorySessionHistoryAdapter implements SessionHistoryAdapter {
  private events = new Map<string, SessionStreamEvent[]>();
  private summaries = new Map<string, SessionSummary>();

  appendEvent(sessionId: string, event: SessionStreamEvent): Promise<void> {
    const arr = this.events.get(sessionId) ?? [];
    arr.push(event);
    this.events.set(sessionId, arr);
    return Promise.resolve();
  }

  save(sessionId: string, events: SessionStreamEvent[], summary: SessionSummary): Promise<void> {
    this.events.set(sessionId, [...events]);
    this.summaries.set(sessionId, summary);
    return Promise.resolve();
  }

  updateSummary(sessionId: string, summary: SessionSummary): Promise<void> {
    this.summaries.set(sessionId, summary);
    return Promise.resolve();
  }

  get(sessionId: string): Promise<SessionView | null> {
    const events = this.events.get(sessionId);
    return Promise.resolve(events ? buildSessionView(events) : null);
  }

  listByWorkspace(workspaceId?: string): Promise<SessionSummary[]> {
    const out: SessionSummary[] = [];
    for (const summary of this.summaries.values()) {
      if (workspaceId === undefined || summary.workspaceId === workspaceId) {
        out.push(summary);
      }
    }
    out.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
    return Promise.resolve(out);
  }

  markInterruptedSessions(): Promise<number> {
    // Sessions with events but no summary are "interrupted." For tests
    // that don't exercise this path, the count is 0; tests that need it
    // can pre-populate events without a corresponding summary.
    let marked = 0;
    for (const sessionId of this.events.keys()) {
      if (!this.summaries.has(sessionId)) marked++;
    }
    return Promise.resolve(marked);
  }

  listInflight(
    _workspaceId?: string,
  ): Promise<
    Array<{ sessionId: string; startedAt: string; workspaceId?: string; signalId?: string }>
  > {
    return Promise.resolve([]);
  }
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function mockNatsConnection(): NatsConnection {
  const jsMock = {
    publish: vi
      .fn<() => Promise<{ stream: string; seq: number }>>()
      .mockResolvedValue({ stream: "SESSION_EVENTS", seq: 1 }),
  };
  return {
    jetstream: vi.fn<() => typeof jsMock>().mockReturnValue(jsMock),
    publish: vi.fn<() => void>(),
  } as unknown as NatsConnection;
}

function makeSessionStart(overrides: Partial<SessionStartEvent> = {}): SessionStartEvent {
  return {
    type: "session:start",
    sessionId: "test-session-1",
    workspaceId: "ws-1",
    jobName: "main",
    task: "Do the thing",
    timestamp: "2026-02-13T10:00:00.000Z",
    ...overrides,
  };
}

function makeStepStart(overrides: Partial<StepStartEvent> = {}): StepStartEvent {
  return {
    type: "step:start",
    sessionId: "test-session-1",
    stepNumber: 1,
    agentName: "planner",
    actionType: "agent",
    task: "Plan the thing",
    timestamp: "2026-02-13T10:00:01.000Z",
    ...overrides,
  };
}

function makeStepComplete(overrides: Partial<StepCompleteEvent> = {}): StepCompleteEvent {
  return {
    type: "step:complete",
    sessionId: "test-session-1",
    stepNumber: 1,
    status: "completed",
    durationMs: 1500,
    toolCalls: [],
    output: { result: "planned" },
    timestamp: "2026-02-13T10:00:02.500Z",
    ...overrides,
  };
}

function makeSessionComplete(
  overrides: Partial<SessionStreamEvent & { type: "session:complete" }> = {},
): SessionStreamEvent {
  return {
    type: "session:complete",
    sessionId: "test-session-1",
    status: "completed",
    durationMs: 3000,
    timestamp: "2026-02-13T10:00:03.000Z",
    ...overrides,
  };
}

function makeSessionSummaryEvent(
  overrides: Partial<SessionSummaryEvent> = {},
): SessionSummaryEvent {
  return {
    type: "session:summary",
    timestamp: "2026-02-13T10:00:03.500Z",
    summary: "Created a deployment plan for the staging environment.",
    keyDetails: [
      { label: "Environment", value: "staging" },
      { label: "PR", value: "#42", url: "https://github.com/org/repo/pull/42" },
    ],
    ...overrides,
  };
}

function makeSessionSummary(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    sessionId: "test-session-1",
    workspaceId: "ws-1",
    jobName: "main",
    task: "Do the thing",
    status: "completed",
    startedAt: "2026-02-13T10:00:00.000Z",
    completedAt: "2026-02-13T10:00:03.000Z",
    durationMs: 3000,
    stepCount: 1,
    agentNames: ["planner"],
    ...overrides,
  };
}

function makeEvents(): SessionStreamEvent[] {
  return [
    makeSessionStart(),
    makeStepStart(),
    makeStepComplete(),
    makeSessionComplete(),
    makeSessionSummaryEvent(),
  ];
}

// ---------------------------------------------------------------------------
// Test app factory
// ---------------------------------------------------------------------------

function createTestApp(options: {
  adapter: SessionHistoryAdapter;
  registry: SessionStreamRegistry;
  /** Maps sessionId → workspaceId. DELETE /:id reads via workspaceOf. */
  dispatchRegistry?: { workspaceOf: (sessionId: string) => string | undefined };
  /** Spy invoked when the cancel route publishes — proves the NATS path fires. */
  natsPublish?: (subject: string, data: Uint8Array) => void;
}) {
  const { adapter, registry, dispatchRegistry, natsPublish } = options;

  const mockContext: AppContext = {
    startTime: Date.now(),
    sseClients: new Map(),
    sseStreams: new Map(),
    getWorkspaceManager: vi.fn() as unknown as AppContext["getWorkspaceManager"],
    daemon: {
      getNatsConnection: () => ({
        publish: (subject: string, data: Uint8Array) => natsPublish?.(subject, data),
        flush: () => Promise.resolve(),
      }),
    } as unknown as AppContext["daemon"],
    streamRegistry: {} as AppContext["streamRegistry"],
    chatTurnRegistry: {} as AppContext["chatTurnRegistry"],
    sessionStreamRegistry: registry,
    sessionHistoryAdapter: adapter,
    sessionDispatchRegistry: (dispatchRegistry ??
      ({ workspaceOf: () => undefined } as unknown)) as AppContext["sessionDispatchRegistry"],
    getAgentRegistry: vi.fn() as unknown as AppContext["getAgentRegistry"],
    getOrCreateChatSdkInstance: vi.fn() as unknown as AppContext["getOrCreateChatSdkInstance"],
    exposeKernel: false,
    platformModels: {} as AppContext["platformModels"],
  };

  const app = new Hono<AppVariables>();
  app.use("*", async (c, next) => {
    c.set("app", mockContext);
    c.set("userId", "test-user");
    await next();
  });
  app.route("/", sessionsRoutes);

  return { app, mockContext };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Session History v2 Routes", () => {
  let testDir: string;
  let adapter: InMemorySessionHistoryAdapter;
  let registry: SessionStreamRegistry;

  beforeEach(async () => {
    // testDir is still required for the v1-format-session route test
    // (line ~340) which writes a legacy session.json onto disk and asserts
    // the route returns 410. The adapter itself is now in-memory.
    testDir = join(
      tmpdir(),
      `session-history-v2-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await mkdir(testDir, { recursive: true });
    mockAtlasHome.value = testDir;
    adapter = new InMemorySessionHistoryAdapter();
    registry = new SessionStreamRegistry(mockNatsConnection());
  });

  afterEach(async () => {
    await registry.shutdown();
    await rm(testDir, { recursive: true, force: true });
  });

  // ==========================================================================
  // GET /:id — JSON detail endpoint
  // ==========================================================================

  describe("GET /:id (JSON detail)", () => {
    test("returns SessionView for completed session from adapter", async () => {
      // Finalize a session via the adapter
      const events = makeEvents();
      const summary = makeSessionSummary();
      await adapter.save("test-session-1", events, summary);

      const { app } = createTestApp({ adapter, registry });
      const res = await app.request("/test-session-1");

      expect(res.status).toBe(200);
      const body = (await res.json()) as SessionView;
      expect(body).toMatchObject({
        sessionId: "test-session-1",
        workspaceId: "ws-1",
        jobName: "main",
        task: "Do the thing",
        status: "completed",
        startedAt: "2026-02-13T10:00:00.000Z",
        durationMs: 3000,
      });
      expect(body.agentBlocks).toHaveLength(1);
      expect(body.agentBlocks[0]).toMatchObject({
        stepNumber: 1,
        agentName: "planner",
        status: "completed",
      });
    });

    test("includes aiSummary for completed session with session:summary event", async () => {
      const events = makeEvents();
      const summary = makeSessionSummary();
      await adapter.save("test-session-1", events, summary);

      const { app } = createTestApp({ adapter, registry });
      const res = await app.request("/test-session-1");

      expect(res.status).toBe(200);
      const body = (await res.json()) as SessionView;
      expect(body.aiSummary).toMatchObject({
        summary: "Created a deployment plan for the staging environment.",
        keyDetails: [
          { label: "Environment", value: "staging" },
          { label: "PR", value: "#42", url: "https://github.com/org/repo/pull/42" },
        ],
      });
    });

    test("returns SessionView snapshot for active session in registry", async () => {
      // Create an active stream with some events
      const stream = registry.create("active-session-1", adapter);
      stream.emit(makeSessionStart({ sessionId: "active-session-1" }));
      stream.emit(makeStepStart({ sessionId: "active-session-1" }));

      const { app } = createTestApp({ adapter, registry });
      const res = await app.request("/active-session-1");

      expect(res.status).toBe(200);
      const body = (await res.json()) as SessionView;
      expect(body).toMatchObject({
        sessionId: "active-session-1",
        workspaceId: "ws-1",
        status: "active",
      });
      expect(body.agentBlocks).toHaveLength(1);
      expect(body.agentBlocks[0]).toMatchObject({ agentName: "planner", status: "running" });
    });

    test("returns 410 Gone for old-format session", async () => {
      // Create a v1-format session file on disk
      const sessionsDir = join(testDir, "sessions");
      await mkdir(sessionsDir, { recursive: true });
      await writeFile(join(sessionsDir, "old-session-1.json"), "{}");

      const { app } = createTestApp({ adapter, registry });
      const res = await app.request("/old-session-1");

      expect(res.status).toBe(410);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toMatch(/outdated/i);
    });

    test("returns 404 for unknown session", async () => {
      const { app } = createTestApp({ adapter, registry });
      const res = await app.request("/nonexistent-session");

      expect(res.status).toBe(404);
    });
  });

  // ==========================================================================
  // GET / — List endpoint
  // ==========================================================================

  describe("GET / (list)", () => {
    test("returns completed session summaries from adapter", async () => {
      await adapter.save(
        "session-1",
        makeEvents().map((e) => ({ ...e, sessionId: "session-1" })),
        makeSessionSummary({ sessionId: "session-1" }),
      );
      await adapter.save(
        "session-2",
        makeEvents().map((e) => ({ ...e, sessionId: "session-2" })),
        makeSessionSummary({ sessionId: "session-2", startedAt: "2026-02-13T11:00:00.000Z" }),
      );

      const { app } = createTestApp({ adapter, registry });
      const res = await app.request("/?workspaceId=ws-1");

      expect(res.status).toBe(200);
      const body = (await res.json()) as { sessions: SessionSummary[] };
      expect(body.sessions).toHaveLength(2);
      // Should be sorted by startedAt descending (session-2 first)
      expect(body.sessions[0]?.sessionId).toBe("session-2");
      expect(body.sessions[1]?.sessionId).toBe("session-1");
    });

    test("includes active session summaries from registry", async () => {
      // Completed session in adapter
      await adapter.save("completed-1", makeEvents(), makeSessionSummary());

      // Active session in registry
      const stream = registry.create("active-1", adapter);
      stream.emit(makeSessionStart({ sessionId: "active-1" }));
      stream.emit(makeStepStart({ sessionId: "active-1" }));

      const { app } = createTestApp({ adapter, registry });
      const res = await app.request("/?workspaceId=ws-1");

      expect(res.status).toBe(200);
      const body = (await res.json()) as { sessions: SessionSummary[] };
      expect(body.sessions).toHaveLength(2);
      // Active session should appear (status: "active")
      const activeSummary = body.sessions.find((s) => s.sessionId === "active-1");
      expect(activeSummary).toBeDefined();
      expect(activeSummary?.status).toBe("active");
    });

    test("filters by workspaceId", async () => {
      await adapter.save("session-ws1", makeEvents(), makeSessionSummary());
      await adapter.save(
        "session-ws2",
        makeEvents().map((e) => ({ ...e, sessionId: "session-ws2" })),
        makeSessionSummary({ sessionId: "session-ws2", workspaceId: "ws-2" }),
      );

      const { app } = createTestApp({ adapter, registry });
      const res = await app.request("/?workspaceId=ws-1");

      expect(res.status).toBe(200);
      const body = (await res.json()) as { sessions: SessionSummary[] };
      expect(body.sessions).toHaveLength(1);
      expect(body.sessions[0]?.workspaceId).toBe("ws-1");
    });

    test("returns aiSummary on completed session summaries from adapter", async () => {
      const aiSummary = {
        summary: "Created a deployment plan for the staging environment.",
        keyDetails: [
          { label: "Environment", value: "staging" },
          { label: "PR", value: "#42", url: "https://github.com/org/repo/pull/42" },
        ],
      };
      await adapter.save(
        "session-with-summary",
        makeEvents().map((e) => ({ ...e, sessionId: "session-with-summary" })),
        makeSessionSummary({ sessionId: "session-with-summary", aiSummary }),
      );

      const { app } = createTestApp({ adapter, registry });
      const res = await app.request("/?workspaceId=ws-1");

      expect(res.status).toBe(200);
      const body = (await res.json()) as { sessions: SessionSummary[] };
      const session = body.sessions.find((s) => s.sessionId === "session-with-summary");
      expect(session?.aiSummary).toMatchObject(aiSummary);
    });

    test("returns aiSummary on active session summaries via viewToSummary", async () => {
      const stream = registry.create("active-with-summary", adapter);
      stream.emit(makeSessionStart({ sessionId: "active-with-summary" }));
      stream.emit(makeStepStart({ sessionId: "active-with-summary" }));
      stream.emit(makeStepComplete({ sessionId: "active-with-summary" }));
      stream.emit(makeSessionSummaryEvent());

      const { app } = createTestApp({ adapter, registry });
      const res = await app.request("/?workspaceId=ws-1");

      expect(res.status).toBe(200);
      const body = (await res.json()) as { sessions: SessionSummary[] };
      const activeSummary = body.sessions.find((s) => s.sessionId === "active-with-summary");
      expect(activeSummary).toBeDefined();
      expect(activeSummary?.aiSummary).toMatchObject({
        summary: "Created a deployment plan for the staging environment.",
        keyDetails: [
          { label: "Environment", value: "staging" },
          { label: "PR", value: "#42", url: "https://github.com/org/repo/pull/42" },
        ],
      });
    });

    test("lists all sessions when no workspaceId provided", async () => {
      await adapter.save(
        "session-ws1",
        makeEvents().map((e) => ({ ...e, sessionId: "session-ws1" })),
        makeSessionSummary({ sessionId: "session-ws1" }),
      );
      await adapter.save(
        "session-ws2",
        makeEvents().map((e) => ({ ...e, sessionId: "session-ws2" })),
        makeSessionSummary({ sessionId: "session-ws2", workspaceId: "ws-2" }),
      );

      const { app } = createTestApp({ adapter, registry });
      const res = await app.request("/");

      expect(res.status).toBe(200);
      const body = (await res.json()) as { sessions: SessionSummary[] };
      expect(body.sessions).toHaveLength(2);
    });
  });

  // -------------------------------------------------------------------------
  // DELETE /:id — cancel via NATS
  // -------------------------------------------------------------------------
  describe("DELETE /:id", () => {
    test("returns 404 when no in-flight session matches the id", async () => {
      const { app } = createTestApp({
        adapter,
        registry,
        dispatchRegistry: { workspaceOf: () => undefined },
      });

      const res = await app.request("/unknown-session", { method: "DELETE" });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("Session not found or not active");
    });

    test("publishes a cancel on daemon.cancel.sessions.<sid> for an active session", async () => {
      const captured: { subject?: string; payload?: string } = {};
      const { app } = createTestApp({
        adapter,
        registry,
        dispatchRegistry: { workspaceOf: (id) => (id === "sess-active" ? "ws-1" : undefined) },
        natsPublish: (subject, data) => {
          captured.subject = subject;
          captured.payload = new TextDecoder().decode(data);
        },
      });

      const res = await app.request("/sess-active", { method: "DELETE" });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { message: string; workspaceId: string };
      expect(body.workspaceId).toBe("ws-1");
      expect(body.message).toContain("sess-active");

      expect(captured.subject).toBe("daemon.cancel.sessions.sess-active");
      // Payload carries the human-readable reason that lands on the AbortError.
      const payload = JSON.parse(captured.payload ?? "{}") as { reason?: string };
      expect(payload.reason).toBe("Session cancelled by user");
    });

    test("authz: returns 403 when caller is not a workspace member", async () => {
      // Override the membership stub to refuse access on this specific call.
      const { WorkspaceMemberStorage } = await import("@atlas/core/workspace-members/storage");
      const stub = vi
        .spyOn(WorkspaceMemberStorage, "get")
        .mockResolvedValueOnce({ ok: true, data: null });

      const { app } = createTestApp({
        adapter,
        registry,
        dispatchRegistry: { workspaceOf: () => "ws-restricted" },
      });

      const res = await app.request("/sess-restricted", { method: "DELETE" });
      // requireWorkspaceMember surfaces authz failures as HTTPException — Hono
      // turns those into 4xx responses; we just need to confirm we're not
      // 200/404 (which would mean we slipped past the guard).
      expect([401, 403]).toContain(res.status);

      stub.mockRestore();
    });
  });
});
