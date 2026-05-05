import type { SessionHistoryAdapter } from "@atlas/core";
import type { NatsConnection } from "nats";
import { aroundEach, describe, expect, test, vi } from "vitest";
import { SessionStreamRegistry } from "./session-stream-registry.ts";

// ---------------------------------------------------------------------------
// Mock adapter
// ---------------------------------------------------------------------------

function mockAdapter(): SessionHistoryAdapter {
  return {
    appendEvent: vi.fn<SessionHistoryAdapter["appendEvent"]>().mockResolvedValue(undefined),
    save: vi.fn<SessionHistoryAdapter["save"]>().mockResolvedValue(undefined),
    get: vi.fn<SessionHistoryAdapter["get"]>().mockResolvedValue(null),
    listByWorkspace: vi.fn<SessionHistoryAdapter["listByWorkspace"]>().mockResolvedValue([]),
    markInterruptedSessions: vi
      .fn<SessionHistoryAdapter["markInterruptedSessions"]>()
      .mockResolvedValue(0),
  };
}

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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let registry: SessionStreamRegistry;

aroundEach(async (run) => {
  vi.useFakeTimers();
  registry = new SessionStreamRegistry(mockNatsConnection());
  registry.start();
  await run();
  await registry.shutdown();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// create / get
// ---------------------------------------------------------------------------

describe("create and get", () => {
  test("creates a stream and retrieves it by sessionId", () => {
    const adapter = mockAdapter();
    const stream = registry.create("sess-1", adapter);

    expect(stream).toBeDefined();
    expect(stream.isActive()).toBe(true);
    expect(registry.get("sess-1")).toBe(stream);
  });

  test("returns undefined for unknown sessionId", () => {
    expect(registry.get("nonexistent")).toBeUndefined();
  });

  test("replacing an existing sessionId returns a new stream", () => {
    const adapter = mockAdapter();
    const first = registry.create("sess-1", adapter);
    const second = registry.create("sess-1", adapter);

    expect(second).not.toBe(first);
    expect(registry.get("sess-1")).toBe(second);
  });
});

// ---------------------------------------------------------------------------
// listActive
// ---------------------------------------------------------------------------

describe("listActive", () => {
  test("returns only non-finalized streams", async () => {
    const adapter = mockAdapter();
    registry.create("sess-1", adapter);
    const stream2 = registry.create("sess-2", adapter);

    await stream2.finalize({
      sessionId: "sess-2",
      workspaceId: "ws-1",
      jobName: "job",
      task: "task",
      status: "completed",
      startedAt: "2026-01-01T00:00:00Z",
      stepCount: 0,
      agentNames: [],
    });

    const active = registry.listActive();
    expect(active).toHaveLength(1);
    const first = active[0];
    expect.assert(first !== undefined);
    expect(first.isActive()).toBe(true);
  });

  test("returns empty array when no streams exist", () => {
    expect(registry.listActive()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// TTL cleanup
// ---------------------------------------------------------------------------

describe("TTL cleanup", () => {
  test("evicts finalized streams after 5 minutes", async () => {
    const adapter = mockAdapter();
    const stream = registry.create("sess-1", adapter);
    await stream.finalize({
      sessionId: "sess-1",
      workspaceId: "ws-1",
      jobName: "job",
      task: "task",
      status: "completed",
      startedAt: "2026-01-01T00:00:00Z",
      stepCount: 0,
      agentNames: [],
    });

    // Advance past finalized TTL (5 min + 1 min cleanup interval)
    vi.advanceTimersByTime(6 * 60 * 1000);

    expect(registry.get("sess-1")).toBeUndefined();
  });

  test("does NOT evict active streams before 30 minutes", () => {
    const adapter = mockAdapter();
    registry.create("sess-1", adapter);

    // Advance 10 minutes
    vi.advanceTimersByTime(10 * 60 * 1000);

    expect(registry.get("sess-1")).toBeDefined();
  });

  test("evicts stale active streams after 30 minutes", () => {
    const adapter = mockAdapter();
    registry.create("sess-1", adapter);

    // Advance past stale TTL (31 minutes)
    vi.advanceTimersByTime(31 * 60 * 1000);

    expect(registry.get("sess-1")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// shutdown
// ---------------------------------------------------------------------------

describe("shutdown", () => {
  test("clears all streams", async () => {
    const adapter = mockAdapter();
    registry.create("sess-1", adapter);
    registry.create("sess-2", adapter);

    await registry.shutdown();

    expect(registry.get("sess-1")).toBeUndefined();
    expect(registry.get("sess-2")).toBeUndefined();
  });
});
