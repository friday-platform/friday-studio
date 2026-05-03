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
});
