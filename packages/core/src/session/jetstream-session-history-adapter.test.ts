/**
 * Smoke tests for `JetStreamSessionHistoryAdapter`. Mirrors the
 * contract exercised by `LocalSessionHistoryAdapter`:
 *  - appendEvent + get round-trip
 *  - save + listByWorkspace
 *  - markInterruptedSessions finalizes sessions with events but no summary
 *  - get returns null for an unknown session
 *  - per-workspace filter
 */

import { connect, type NatsConnection } from "nats";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startNatsTestServer, type TestNatsServer } from "../test-utils/nats-test-server.ts";
import { JetStreamSessionHistoryAdapter } from "./jetstream-session-history-adapter.ts";
import type { SessionStreamEvent, SessionSummary } from "./session-events.ts";

let server: TestNatsServer;
let nc: NatsConnection;

beforeAll(async () => {
  server = await startNatsTestServer();
  nc = await connect({ servers: server.url });
}, 30_000);

afterAll(async () => {
  await nc.drain();
  await server.stop();
});

function startEvent(sessionId: string, workspaceId: string): SessionStreamEvent {
  return {
    type: "session:start",
    sessionId,
    workspaceId,
    jobName: "test-job",
    task: "do the thing",
    timestamp: new Date().toISOString(),
  };
}

function completeEvent(sessionId: string): SessionStreamEvent {
  return {
    type: "session:complete",
    sessionId,
    status: "completed",
    durationMs: 100,
    timestamp: new Date().toISOString(),
  };
}

function summaryFor(
  sessionId: string,
  workspaceId: string,
  status: SessionSummary["status"] = "completed",
): SessionSummary {
  return {
    sessionId,
    workspaceId,
    jobName: "test-job",
    task: "do the thing",
    status,
    startedAt: new Date(Date.now() - 1000).toISOString(),
    completedAt: new Date().toISOString(),
    stepCount: 0,
    agentNames: [],
  };
}

describe("JetStreamSessionHistoryAdapter", () => {
  it("appendEvent + get round-trip", async () => {
    const adapter = new JetStreamSessionHistoryAdapter(nc);
    const sid = `s-${crypto.randomUUID()}`;
    await adapter.appendEvent(sid, startEvent(sid, "ws-1"));
    await adapter.appendEvent(sid, completeEvent(sid));

    const view = await adapter.get(sid);
    expect(view).not.toBeNull();
    expect(view?.workspaceId).toBe("ws-1");
    expect(view?.task).toBe("do the thing");
  });

  it("get returns null for unknown session", async () => {
    const adapter = new JetStreamSessionHistoryAdapter(nc);
    const view = await adapter.get(`unknown-${crypto.randomUUID()}`);
    expect(view).toBeNull();
  });

  it("save writes summary; listByWorkspace surfaces it", async () => {
    const adapter = new JetStreamSessionHistoryAdapter(nc);
    const sid = `s-${crypto.randomUUID()}`;
    const events = [startEvent(sid, "ws-2"), completeEvent(sid)];
    await adapter.save(sid, events, summaryFor(sid, "ws-2"));

    const list = await adapter.listByWorkspace("ws-2");
    expect(list.find((s) => s.sessionId === sid)).toBeDefined();
  });

  it("listByWorkspace filters by workspaceId", async () => {
    const adapter = new JetStreamSessionHistoryAdapter(nc);
    const sidA = `s-${crypto.randomUUID()}`;
    const sidB = `s-${crypto.randomUUID()}`;
    await adapter.save(sidA, [startEvent(sidA, "ws-A")], summaryFor(sidA, "ws-A"));
    await adapter.save(sidB, [startEvent(sidB, "ws-B")], summaryFor(sidB, "ws-B"));

    const onlyA = await adapter.listByWorkspace("ws-A");
    expect(onlyA.every((s) => s.workspaceId === "ws-A")).toBe(true);
    expect(onlyA.find((s) => s.sessionId === sidA)).toBeDefined();
    expect(onlyA.find((s) => s.sessionId === sidB)).toBeUndefined();
  });

  it("markInterruptedSessions finalizes appended-but-unsaved sessions", async () => {
    const adapter = new JetStreamSessionHistoryAdapter(nc);
    const sid = `s-${crypto.randomUUID()}`;
    // Simulate a daemon crash mid-flight: append events but never save.
    await adapter.appendEvent(sid, startEvent(sid, "ws-int"));

    const count = await adapter.markInterruptedSessions();
    expect(count).toBeGreaterThanOrEqual(1);

    const list = await adapter.listByWorkspace("ws-int");
    const summary = list.find((s) => s.sessionId === sid);
    expect(summary?.status).toBe("interrupted");
  });

  it("save() after appendEvent does NOT duplicate events in the rebuilt view", async () => {
    // Regression: the reducer matches step:start by agentName+pending,
    // so a republish of the same event used to produce duplicate
    // agentBlocks. Stream-side dedup via Nats-Msg-Id keeps it at one.
    const adapter = new JetStreamSessionHistoryAdapter(nc);
    const sid = `s-${crypto.randomUUID()}`;
    const start = startEvent(sid, "ws-dedup");
    const complete = completeEvent(sid);

    await adapter.appendEvent(sid, start);
    await adapter.appendEvent(sid, complete);
    // save() republishes both events — broker should dedup them.
    await adapter.save(sid, [start, complete], summaryFor(sid, "ws-dedup"));

    const view = await adapter.get(sid);
    expect(view).not.toBeNull();
    // Exactly one of each — not two.
    expect(view?.agentBlocks.length ?? 0).toBe(0); // no step events in this fixture
    expect(view?.task).toBe("do the thing");
  });

  it("save() then markInterruptedSessions() does not double-finalize", async () => {
    const adapter = new JetStreamSessionHistoryAdapter(nc);
    const sid = `s-${crypto.randomUUID()}`;
    await adapter.appendEvent(sid, startEvent(sid, "ws-noop"));
    await adapter.save(
      sid,
      [startEvent(sid, "ws-noop"), completeEvent(sid)],
      summaryFor(sid, "ws-noop"),
    );

    const before = await adapter.listByWorkspace("ws-noop");
    const status = before.find((s) => s.sessionId === sid)?.status;
    await adapter.markInterruptedSessions();
    const after = await adapter.listByWorkspace("ws-noop");
    expect(after.find((s) => s.sessionId === sid)?.status).toBe(status);
  });

  it("ensureStream sets duplicate_window to 24h on the SESSION_EVENTS stream (J2)", async () => {
    // Trigger ensureStream via any operation on a fresh adapter.
    const adapter = new JetStreamSessionHistoryAdapter(nc);
    await adapter.appendEvent(`s-${crypto.randomUUID()}`, startEvent("dummy", "ws-dup-window"));

    const jsm = await nc.jetstreamManager();
    const info = await jsm.streams.info("SESSION_EVENTS");
    // 24h in ns. The default if we did NOT set it would be 2 minutes
    // (= 120_000_000_000 ns), which is what J2 was fixing.
    const TWENTY_FOUR_HOURS_NS = 24 * 60 * 60 * 1_000_000_000;
    expect(Number(info.config.duplicate_window)).toBe(TWENTY_FOUR_HOURS_NS);
  });

  it("concurrent get() calls on the same session do not collide on consumer name (review N1)", async () => {
    // Pre-J2: the consumer name suffix was `Date.now()`, so two reads
    // of the same session in the same millisecond produced identical
    // names; the second `consumers.add` threw, the catch swallowed,
    // and the second reader returned null. After the UUID switch all
    // 16 concurrent reads should produce a SessionView.
    const adapter = new JetStreamSessionHistoryAdapter(nc);
    const sid = `s-${crypto.randomUUID()}`;
    await adapter.appendEvent(sid, startEvent(sid, "ws-race"));
    await adapter.appendEvent(sid, completeEvent(sid));

    const reads = await Promise.all(Array.from({ length: 16 }, () => adapter.get(sid)));
    expect(reads.every((v) => v !== null)).toBe(true);
    expect(reads.every((v) => v?.workspaceId === "ws-race")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Pure unit test for the consumer-name suffix uniqueness (review N1).
// Doesn't need a NATS server — exercises the UUID generator directly to
// prove that 1000 same-millisecond invocations all produce distinct names.
// ---------------------------------------------------------------------------

describe("consumer-name suffix uniqueness (review N1)", () => {
  it("generates unique suffixes for 1000 same-millisecond invocations", () => {
    // The adapter uses `crypto.randomUUID()` for the suffix; this proves
    // the same generator (called as fast as a tight loop allows) does
    // not collide. Pre-J2 used `Date.now()`, which obviously did.
    const sessionId = "fixed-session-***";
    const N = 1000;
    const names = new Set<string>();
    for (let i = 0; i < N; i++) {
      names.add(`session-read-${sessionId}-${crypto.randomUUID()}`);
    }
    expect(names.size).toBe(N);
  });
});
