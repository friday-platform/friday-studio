import type {
  EphemeralChunk,
  SessionHistoryAdapter,
  SessionStreamEvent,
  SessionSummary,
} from "@atlas/core";
import { describe, expect, test, vi } from "vitest";
import { SessionEventStream } from "./session-event-stream.ts";
import type { StreamController } from "./stream-registry.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW = "2026-02-13T10:00:00.000Z";

function sessionStart(): SessionStreamEvent {
  return {
    type: "session:start",
    sessionId: "sess-1",
    workspaceId: "ws-1",
    jobName: "my-job",
    task: "do the thing",
    timestamp: NOW,
  };
}

function stepStart(stepNumber = 1): SessionStreamEvent {
  return {
    type: "step:start",
    sessionId: "sess-1",
    stepNumber,
    agentName: "researcher",
    actionType: "agent",
    task: "research",
    timestamp: NOW,
  };
}

function stepComplete(stepNumber = 1): SessionStreamEvent {
  return {
    type: "step:complete",
    sessionId: "sess-1",
    stepNumber,
    status: "completed",
    durationMs: 1234,
    toolCalls: [{ toolName: "search", args: { q: "test" } }],
    output: { answer: 42 },
    timestamp: NOW,
  };
}

function sessionComplete(): SessionStreamEvent {
  return {
    type: "session:complete",
    sessionId: "sess-1",
    status: "completed",
    durationMs: 5000,
    timestamp: NOW,
  };
}

function ephemeralChunk(stepNumber = 1): EphemeralChunk {
  return {
    stepNumber,
    chunk: { type: "text-delta", textDelta: "thinking..." } as unknown as EphemeralChunk["chunk"],
  };
}

function summary(): SessionSummary {
  return {
    sessionId: "sess-1",
    workspaceId: "ws-1",
    jobName: "my-job",
    task: "do the thing",
    status: "completed",
    startedAt: NOW,
    completedAt: NOW,
    durationMs: 5000,
    stepCount: 1,
    agentNames: ["researcher"],
  };
}

function mockAdapter(): SessionHistoryAdapter {
  return {
    appendEvent: vi.fn<SessionHistoryAdapter["appendEvent"]>().mockResolvedValue(undefined),
    save: vi.fn<SessionHistoryAdapter["save"]>().mockResolvedValue(undefined),
    get: vi.fn<SessionHistoryAdapter["get"]>().mockResolvedValue(null),
    listByWorkspace: vi.fn<SessionHistoryAdapter["listByWorkspace"]>().mockResolvedValue([]),
  };
}

function mockController() {
  return {
    enqueue: vi.fn<StreamController["enqueue"]>(),
    close: vi.fn<StreamController["close"]>(),
  } satisfies StreamController;
}

// ---------------------------------------------------------------------------
// emit
// ---------------------------------------------------------------------------

describe("emit", () => {
  test("buffers durable events", () => {
    const stream = new SessionEventStream("sess-1", mockAdapter());
    stream.emit(sessionStart());
    stream.emit(stepStart());

    const events = stream.getBufferedEvents();
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ type: "session:start" });
  });

  test("broadcasts to subscribers", () => {
    const stream = new SessionEventStream("sess-1", mockAdapter());
    const ctrl = mockController();
    stream.subscribe(ctrl);

    stream.emit(sessionStart());

    expect(ctrl.enqueue).toHaveBeenCalledOnce();
  });

  test("fire-and-forget appendEvent to adapter", () => {
    const adapter = mockAdapter();
    const stream = new SessionEventStream("sess-1", adapter);

    stream.emit(sessionStart());

    expect(adapter.appendEvent).toHaveBeenCalledWith("sess-1", sessionStart());
  });
});

// ---------------------------------------------------------------------------
// emitEphemeral
// ---------------------------------------------------------------------------

describe("emitEphemeral", () => {
  test("broadcasts to subscribers", () => {
    const stream = new SessionEventStream("sess-1", mockAdapter());
    const ctrl = mockController();
    stream.subscribe(ctrl);

    stream.emitEphemeral(ephemeralChunk());

    expect(ctrl.enqueue).toHaveBeenCalledOnce();
  });

  test("does NOT buffer ephemeral chunks", () => {
    const stream = new SessionEventStream("sess-1", mockAdapter());
    stream.emitEphemeral(ephemeralChunk());

    expect(stream.getBufferedEvents()).toHaveLength(0);
  });

  test("does NOT persist ephemeral chunks", () => {
    const adapter = mockAdapter();
    const stream = new SessionEventStream("sess-1", adapter);

    stream.emitEphemeral(ephemeralChunk());

    expect(adapter.appendEvent).not.toHaveBeenCalled();
  });

  test("encodes with 'event: ephemeral' SSE header", () => {
    const stream = new SessionEventStream("sess-1", mockAdapter());
    const ctrl = mockController();
    stream.subscribe(ctrl);

    stream.emitEphemeral(ephemeralChunk());

    const call = ctrl.enqueue.mock.calls[0];
    expect.assert(call !== undefined);
    const text = new TextDecoder().decode(call[0]);
    expect(text).toMatch(/^event: ephemeral\n/);
    expect(text).toContain(`data: ${JSON.stringify(ephemeralChunk())}\n\n`);
  });
});

describe("SSE encoding", () => {
  test("durable events have no event prefix", () => {
    const stream = new SessionEventStream("sess-1", mockAdapter());
    const ctrl = mockController();
    stream.subscribe(ctrl);

    stream.emit(sessionStart());

    const call = ctrl.enqueue.mock.calls[0];
    expect.assert(call !== undefined);
    const text = new TextDecoder().decode(call[0]);
    expect(text).toBe(`data: ${JSON.stringify(sessionStart())}\n\n`);
    expect(text).not.toContain("event:");
  });
});

// ---------------------------------------------------------------------------
// subscribe (replay)
// ---------------------------------------------------------------------------

describe("subscribe", () => {
  test("replays all buffered events to new subscriber", () => {
    const stream = new SessionEventStream("sess-1", mockAdapter());
    stream.emit(sessionStart());
    stream.emit(stepStart());

    const ctrl = mockController();
    stream.subscribe(ctrl);

    // 2 replayed events
    expect(ctrl.enqueue).toHaveBeenCalledTimes(2);
  });

  test("late subscriber receives full replay", () => {
    const stream = new SessionEventStream("sess-1", mockAdapter());
    stream.emit(sessionStart());
    stream.emit(stepStart());
    stream.emit(stepComplete());
    stream.emit(sessionComplete());

    const ctrl = mockController();
    stream.subscribe(ctrl);

    expect(ctrl.enqueue).toHaveBeenCalledTimes(4);
  });

  test("does NOT replay ephemeral chunks", () => {
    const stream = new SessionEventStream("sess-1", mockAdapter());
    stream.emit(sessionStart());
    stream.emitEphemeral(ephemeralChunk());

    const ctrl = mockController();
    stream.subscribe(ctrl);

    // Only the durable event replayed
    expect(ctrl.enqueue).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// unsubscribe
// ---------------------------------------------------------------------------

describe("unsubscribe", () => {
  test("removed subscriber does not receive new events", () => {
    const stream = new SessionEventStream("sess-1", mockAdapter());
    const ctrl = mockController();
    stream.subscribe(ctrl);
    stream.unsubscribe(ctrl);

    stream.emit(sessionStart());

    // No calls after unsubscribe (0 from subscribe since no buffered events, 0 from emit)
    expect(ctrl.enqueue).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// finalize
// ---------------------------------------------------------------------------

describe("finalize", () => {
  test("calls adapter.save with events and summary", async () => {
    const adapter = mockAdapter();
    const stream = new SessionEventStream("sess-1", adapter);
    stream.emit(sessionStart());
    stream.emit(stepStart());
    stream.emit(stepComplete());
    stream.emit(sessionComplete());

    await stream.finalize(summary());

    expect(adapter.save).toHaveBeenCalledWith(
      "sess-1",
      [sessionStart(), stepStart(), stepComplete(), sessionComplete()],
      summary(),
    );
  });

  test("closes all subscriber connections", async () => {
    const stream = new SessionEventStream("sess-1", mockAdapter());
    const ctrl1 = mockController();
    const ctrl2 = mockController();
    stream.subscribe(ctrl1);
    stream.subscribe(ctrl2);

    await stream.finalize(summary());

    expect(ctrl1.close).toHaveBeenCalledOnce();
    expect(ctrl2.close).toHaveBeenCalledOnce();
  });

  test("marks stream as inactive", async () => {
    const stream = new SessionEventStream("sess-1", mockAdapter());
    expect(stream.isActive()).toBe(true);

    await stream.finalize(summary());

    expect(stream.isActive()).toBe(false);
  });

  test("after finalize, new subscriber gets full replay then close", () => {
    const stream = new SessionEventStream("sess-1", mockAdapter());
    stream.emit(sessionStart());
    stream.emit(sessionComplete());

    // Fire-and-forget finalize (we already tested the async part)
    void stream.finalize(summary());

    const ctrl = mockController();
    stream.subscribe(ctrl);

    // Replay 2 events, then close
    expect(ctrl.enqueue).toHaveBeenCalledTimes(2);
    expect(ctrl.close).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// isActive / getBufferedEvents
// ---------------------------------------------------------------------------

describe("isActive", () => {
  test("returns true before finalize", () => {
    const stream = new SessionEventStream("sess-1", mockAdapter());
    expect(stream.isActive()).toBe(true);
  });
});

describe("getBufferedEvents", () => {
  test("returns a copy (not the internal array)", () => {
    const stream = new SessionEventStream("sess-1", mockAdapter());
    stream.emit(sessionStart());

    const events = stream.getBufferedEvents();
    events.push(stepStart());

    expect(stream.getBufferedEvents()).toHaveLength(1);
  });
});
