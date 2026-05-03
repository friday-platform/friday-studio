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
  LocalSessionHistoryAdapter,
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

// Mock getFridayHome so the v1 file check uses our temp directory
const mockAtlasHome = vi.hoisted(() => ({ value: "" }));
vi.mock("@atlas/utils/paths.server", () => ({ getFridayHome: () => mockAtlasHome.value }));

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function mockNatsConnection(): NatsConnection {
  const jsMock = {
    publish: vi
      .fn<() => Promise<{ stream: string; seq: number }>>()
      .mockResolvedValue({ stream: "SESSIONS", seq: 1 }),
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
}) {
  const { adapter, registry } = options;

  const mockContext: AppContext = {
    runtimes: new Map(),
    startTime: Date.now(),
    sseClients: new Map(),
    sseStreams: new Map(),
    getWorkspaceManager: vi.fn() as unknown as AppContext["getWorkspaceManager"],
    getOrCreateWorkspaceRuntime: vi.fn() as unknown as AppContext["getOrCreateWorkspaceRuntime"],
    resetIdleTimeout: vi.fn(),
    getWorkspaceRuntime: vi.fn() as unknown as AppContext["getWorkspaceRuntime"],
    destroyWorkspaceRuntime: vi.fn() as unknown as AppContext["destroyWorkspaceRuntime"],
    daemon: {} as AppContext["daemon"],
    streamRegistry: {} as AppContext["streamRegistry"],
    chatTurnRegistry: {} as AppContext["chatTurnRegistry"],
    sessionStreamRegistry: registry,
    sessionHistoryAdapter: adapter,
    getAgentRegistry: vi.fn() as unknown as AppContext["getAgentRegistry"],
    getOrCreateChatSdkInstance: vi.fn() as unknown as AppContext["getOrCreateChatSdkInstance"],
    evictChatSdkInstance: vi.fn() as unknown as AppContext["evictChatSdkInstance"],
    exposeKernel: false,
    platformModels: {} as AppContext["platformModels"],
  };

  const app = new Hono<AppVariables>();
  app.use("*", async (c, next) => {
    c.set("app", mockContext);
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
  let adapter: LocalSessionHistoryAdapter;
  let registry: SessionStreamRegistry;

  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `session-history-v2-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await mkdir(testDir, { recursive: true });
    // Point getFridayHome() at our temp directory so v1 file checks work
    mockAtlasHome.value = testDir;
    adapter = new LocalSessionHistoryAdapter(testDir);
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
});
