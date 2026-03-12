import { describe, expect, test } from "vitest";

import type {
  EphemeralChunk,
  SessionCompleteEvent,
  SessionStartEvent,
  StepCompleteEvent,
  StepStartEvent,
} from "./session-events.ts";
import { buildSessionView, initialSessionView, reduceSessionEvent } from "./session-reducer.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW = "2026-02-13T10:00:00.000Z";
const LATER = "2026-02-13T10:00:05.000Z";

function sessionStart(overrides?: Partial<SessionStartEvent>): SessionStartEvent {
  return {
    type: "session:start",
    sessionId: "sess-1",
    workspaceId: "ws-1",
    jobName: "my-job",
    task: "do the thing",
    timestamp: NOW,
    ...overrides,
  };
}

function stepStart(overrides?: Partial<StepStartEvent>): StepStartEvent {
  return {
    type: "step:start",
    sessionId: "sess-1",
    stepNumber: 1,
    agentName: "researcher",
    actionType: "agent",
    task: "research the thing",
    timestamp: NOW,
    ...overrides,
  };
}

function stepComplete(overrides?: Partial<StepCompleteEvent>): StepCompleteEvent {
  return {
    type: "step:complete",
    sessionId: "sess-1",
    stepNumber: 1,
    status: "completed",
    durationMs: 1234,
    toolCalls: [{ toolName: "search", args: { q: "test" } }],
    output: { answer: 42 },
    timestamp: NOW,
    ...overrides,
  };
}

function sessionComplete(overrides?: Partial<SessionCompleteEvent>): SessionCompleteEvent {
  return {
    type: "session:complete",
    sessionId: "sess-1",
    status: "completed",
    durationMs: 5000,
    timestamp: LATER,
    ...overrides,
  };
}

function ephemeralChunk(overrides?: Partial<EphemeralChunk>): EphemeralChunk {
  return {
    stepNumber: 1,
    chunk: { type: "text-delta", delta: "thinking...", id: "eph-1" },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// initialSessionView
// ---------------------------------------------------------------------------

describe("initialSessionView", () => {
  test("returns an empty SessionView with active status", () => {
    const view = initialSessionView();
    expect(view.sessionId).toBe("");
    expect(view.workspaceId).toBe("");
    expect(view.jobName).toBe("");
    expect(view.task).toBe("");
    expect(view.status).toBe("active");
    expect(view.startedAt).toBe("");
    expect(view.agentBlocks).toEqual([]);
    expect(view.completedAt).toBeUndefined();
    expect(view.durationMs).toBeUndefined();
    expect(view.error).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// session:start
// ---------------------------------------------------------------------------

describe("session:start", () => {
  test("initializes SessionView with metadata", () => {
    const view = reduceSessionEvent(initialSessionView(), sessionStart());
    expect(view.sessionId).toBe("sess-1");
    expect(view.workspaceId).toBe("ws-1");
    expect(view.jobName).toBe("my-job");
    expect(view.task).toBe("do the thing");
    expect(view.status).toBe("active");
    expect(view.startedAt).toBe(NOW);
    expect(view.agentBlocks).toEqual([]);
  });

  test("seeds pending blocks from plannedSteps", () => {
    const view = reduceSessionEvent(
      initialSessionView(),
      sessionStart({
        plannedSteps: [
          { agentName: "researcher", task: "research", actionType: "agent" },
          { agentName: "writer", task: "write report", actionType: "llm" },
        ],
      }),
    );

    expect(view.agentBlocks).toHaveLength(2);
    expect(view.agentBlocks[0]).toMatchObject({
      agentName: "researcher",
      stateId: undefined,
      task: "research",
      actionType: "agent",
      status: "pending",
      stepNumber: undefined,
      toolCalls: [],
    });
    expect(view.agentBlocks[1]).toMatchObject({
      agentName: "writer",
      stateId: undefined,
      task: "write report",
      actionType: "llm",
      status: "pending",
      stepNumber: undefined,
    });
  });

  test("no plannedSteps produces empty agentBlocks (backward compat)", () => {
    const view = reduceSessionEvent(initialSessionView(), sessionStart());
    expect(view.agentBlocks).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// step:start
// ---------------------------------------------------------------------------

describe("step:start", () => {
  test("appends a new AgentBlock with status running", () => {
    let view = reduceSessionEvent(initialSessionView(), sessionStart());
    view = reduceSessionEvent(view, stepStart());

    expect(view.agentBlocks).toHaveLength(1);
    const block = view.agentBlocks[0];
    expect.assert(block !== undefined);
    expect(block.stepNumber).toBe(1);
    expect(block.agentName).toBe("researcher");
    expect(block.actionType).toBe("agent");
    expect(block.task).toBe("research the thing");
    expect(block.status).toBe("running");
    expect(block.toolCalls).toEqual([]);
    expect(block.output).toBeUndefined();
  });

  test("transitions first matching pending block to running (preserves position)", () => {
    let view = reduceSessionEvent(
      initialSessionView(),
      sessionStart({
        plannedSteps: [
          { agentName: "researcher", task: "research", actionType: "agent" },
          { agentName: "writer", task: "write", actionType: "llm" },
        ],
      }),
    );

    view = reduceSessionEvent(view, stepStart({ stepNumber: 1, agentName: "researcher" }));

    expect(view.agentBlocks).toHaveLength(2);
    // First block transitioned to running, stays at index 0
    expect(view.agentBlocks[0]).toMatchObject({
      agentName: "researcher",
      status: "running",
      stepNumber: 1,
      task: "research the thing", // runtime task overrides planned task
    });
    // Second block still pending
    expect(view.agentBlocks[1]).toMatchObject({
      agentName: "writer",
      status: "pending",
      stepNumber: undefined,
    });
  });

  test("preserves planned stateId when step:start omits stateId", () => {
    let view = reduceSessionEvent(
      initialSessionView(),
      sessionStart({
        plannedSteps: [
          {
            agentName: "researcher",
            stateId: "planned-state",
            task: "research",
            actionType: "agent",
          },
        ],
      }),
    );

    view = reduceSessionEvent(view, stepStart({ stepNumber: 1, agentName: "researcher" }));

    expect(view.agentBlocks[0]).toMatchObject({
      agentName: "researcher",
      stateId: "planned-state",
      status: "running",
    });
  });

  test("step:start stateId overrides planned stateId", () => {
    let view = reduceSessionEvent(
      initialSessionView(),
      sessionStart({
        plannedSteps: [
          {
            agentName: "researcher",
            stateId: "planned-state",
            task: "research",
            actionType: "agent",
          },
        ],
      }),
    );

    view = reduceSessionEvent(
      view,
      stepStart({ stepNumber: 1, agentName: "researcher", stateId: "runtime-state" }),
    );

    expect(view.agentBlocks[0]).toMatchObject({
      agentName: "researcher",
      stateId: "runtime-state",
      status: "running",
    });
  });

  test("appends new block when no pending block matches (dynamic step)", () => {
    let view = reduceSessionEvent(
      initialSessionView(),
      sessionStart({
        plannedSteps: [{ agentName: "researcher", task: "research", actionType: "agent" }],
      }),
    );

    // "editor" was not planned — should be appended
    view = reduceSessionEvent(view, stepStart({ stepNumber: 1, agentName: "editor" }));

    expect(view.agentBlocks).toHaveLength(2);
    const planned = view.agentBlocks[0];
    const dynamic = view.agentBlocks[1];
    expect.assert(planned !== undefined);
    expect.assert(dynamic !== undefined);
    expect(planned.status).toBe("pending"); // planned researcher untouched
    expect(dynamic).toMatchObject({ agentName: "editor", status: "running", stepNumber: 1 });
  });

  test("duplicate agent names: matches first unmatched pending block", () => {
    let view = reduceSessionEvent(
      initialSessionView(),
      sessionStart({
        plannedSteps: [
          { agentName: "researcher", task: "first pass", actionType: "agent" },
          { agentName: "researcher", task: "second pass", actionType: "agent" },
        ],
      }),
    );

    // First step:start claims the first pending "researcher"
    view = reduceSessionEvent(view, stepStart({ stepNumber: 1, agentName: "researcher" }));
    const first = view.agentBlocks[0];
    const second = view.agentBlocks[1];
    expect.assert(first !== undefined);
    expect.assert(second !== undefined);
    expect(first.status).toBe("running");
    expect(second.status).toBe("pending");

    // Second step:start claims the second pending "researcher"
    view = reduceSessionEvent(view, stepStart({ stepNumber: 2, agentName: "researcher" }));
    const firstAfter = view.agentBlocks[0];
    const secondAfter = view.agentBlocks[1];
    expect.assert(firstAfter !== undefined);
    expect.assert(secondAfter !== undefined);
    expect(firstAfter.status).toBe("running");
    expect(secondAfter.status).toBe("running");
    expect(secondAfter.stepNumber).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// step:complete
// ---------------------------------------------------------------------------

describe("step:complete", () => {
  test("finalizes the matching AgentBlock by stepNumber", () => {
    let view = reduceSessionEvent(initialSessionView(), sessionStart());
    view = reduceSessionEvent(view, stepStart());
    view = reduceSessionEvent(view, stepComplete());

    expect(view.agentBlocks).toHaveLength(1);
    const block = view.agentBlocks[0];
    expect.assert(block !== undefined);
    expect(block.status).toBe("completed");
    expect(block.durationMs).toBe(1234);
    expect(block.toolCalls).toEqual([{ toolName: "search", args: { q: "test" } }]);
    expect(block.output).toEqual({ answer: 42 });
    expect(block.error).toBeUndefined();
    expect(block.ephemeral).toBeUndefined();
  });

  test("clears ephemeral on step completion", () => {
    let view = reduceSessionEvent(initialSessionView(), sessionStart());
    view = reduceSessionEvent(view, stepStart());
    view = reduceSessionEvent(view, ephemeralChunk());
    const beforeComplete = view.agentBlocks[0];
    expect.assert(beforeComplete !== undefined);
    expect(beforeComplete.ephemeral).toHaveLength(1);

    view = reduceSessionEvent(view, stepComplete());
    const afterComplete = view.agentBlocks[0];
    expect.assert(afterComplete !== undefined);
    expect(afterComplete.ephemeral).toBeUndefined();
  });

  test("sets failed status and populates error", () => {
    let view = reduceSessionEvent(initialSessionView(), sessionStart());
    view = reduceSessionEvent(view, stepStart());
    view = reduceSessionEvent(view, stepComplete({ status: "failed", error: "agent crashed" }));

    const block = view.agentBlocks[0];
    expect.assert(block !== undefined);
    expect(block.status).toBe("failed");
    expect(block.error).toBe("agent crashed");
  });

  test("handles step:complete with no matching step:start (no crash)", () => {
    let view = reduceSessionEvent(initialSessionView(), sessionStart());
    // step:complete for stepNumber 99 — never started
    view = reduceSessionEvent(view, stepComplete({ stepNumber: 99 }));

    // Should create a placeholder block, not crash
    const block = view.agentBlocks.find((b) => b.stepNumber === 99);
    expect(block).toBeDefined();
    expect(block?.status).toBe("completed");
  });
});

// ---------------------------------------------------------------------------
// session:complete
// ---------------------------------------------------------------------------

describe("session:complete", () => {
  test("sets session status, completedAt, durationMs", () => {
    let view = reduceSessionEvent(initialSessionView(), sessionStart());
    view = reduceSessionEvent(view, sessionComplete());

    expect(view.status).toBe("completed");
    expect(view.completedAt).toBe(LATER);
    expect(view.durationMs).toBe(5000);
    expect(view.error).toBeUndefined();
  });

  test("propagates error to SessionView", () => {
    let view = reduceSessionEvent(initialSessionView(), sessionStart());
    view = reduceSessionEvent(
      view,
      sessionComplete({ status: "failed", error: "session timeout" }),
    );

    expect(view.status).toBe("failed");
    expect(view.error).toBe("session timeout");
  });

  test("transitions remaining pending blocks to skipped", () => {
    let view = reduceSessionEvent(
      initialSessionView(),
      sessionStart({
        plannedSteps: [
          { agentName: "fetcher", task: "Fetch data", actionType: "agent" },
          { agentName: "writer", task: "Write report", actionType: "llm" },
        ],
      }),
    );

    // Only first step executes
    view = reduceSessionEvent(view, stepStart({ stepNumber: 1, agentName: "fetcher" }));
    view = reduceSessionEvent(view, stepComplete({ stepNumber: 1 }));
    view = reduceSessionEvent(view, sessionComplete());

    const completed = view.agentBlocks[0];
    const skipped = view.agentBlocks[1];
    expect.assert(completed !== undefined);
    expect.assert(skipped !== undefined);
    expect(completed.status).toBe("completed");
    expect(skipped.status).toBe("skipped");
  });

  test("skipped blocks excluded from results map", () => {
    let view = reduceSessionEvent(
      initialSessionView(),
      sessionStart({
        plannedSteps: [
          { agentName: "fetcher", task: "Fetch data", actionType: "agent" },
          { agentName: "writer", task: "Write report", actionType: "llm" },
        ],
      }),
    );

    view = reduceSessionEvent(view, stepStart({ stepNumber: 1, agentName: "fetcher" }));
    view = reduceSessionEvent(view, stepComplete({ stepNumber: 1, output: { data: "fetched" } }));
    view = reduceSessionEvent(view, sessionComplete());

    // Results only contain the completed block
    expect(view.results).toEqual({ fetcher: { data: "fetched" } });
  });

  test("mixed completed and skipped blocks", () => {
    let view = reduceSessionEvent(
      initialSessionView(),
      sessionStart({
        plannedSteps: [
          { agentName: "step-a", task: "A", actionType: "agent" },
          { agentName: "step-b", task: "B", actionType: "agent" },
          { agentName: "step-c", task: "C", actionType: "agent" },
        ],
      }),
    );

    // Execute step-a and step-b, skip step-c
    view = reduceSessionEvent(view, stepStart({ stepNumber: 1, agentName: "step-a" }));
    view = reduceSessionEvent(view, stepComplete({ stepNumber: 1, output: { a: true } }));
    view = reduceSessionEvent(view, stepStart({ stepNumber: 2, agentName: "step-b" }));
    view = reduceSessionEvent(view, stepComplete({ stepNumber: 2, output: { b: true } }));
    view = reduceSessionEvent(view, sessionComplete());

    const blockA = view.agentBlocks[0];
    const blockB = view.agentBlocks[1];
    const blockC = view.agentBlocks[2];
    expect.assert(blockA !== undefined);
    expect.assert(blockB !== undefined);
    expect.assert(blockC !== undefined);
    expect(blockA.status).toBe("completed");
    expect(blockB.status).toBe("completed");
    expect(blockC.status).toBe("skipped");
    expect(view.results).toEqual({ "step-a": { a: true }, "step-b": { b: true } });
  });

  test("no pending blocks: session:complete unchanged (backward compat)", () => {
    let view = reduceSessionEvent(initialSessionView(), sessionStart());
    view = reduceSessionEvent(view, stepStart());
    view = reduceSessionEvent(view, stepComplete());
    view = reduceSessionEvent(view, sessionComplete());

    // No pending blocks existed, so no skipped blocks
    expect(view.agentBlocks.every((b) => b.status !== "skipped")).toBe(true);
    expect(view.agentBlocks.every((b) => b.status !== "pending")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// EphemeralChunk
// ---------------------------------------------------------------------------

describe("EphemeralChunk", () => {
  test("appends chunk to the correct AgentBlock by stepNumber", () => {
    let view = reduceSessionEvent(initialSessionView(), sessionStart());
    view = reduceSessionEvent(view, stepStart({ stepNumber: 1 }));
    view = reduceSessionEvent(view, stepStart({ stepNumber: 2, agentName: "writer" }));

    view = reduceSessionEvent(view, ephemeralChunk({ stepNumber: 2 }));

    const researcher = view.agentBlocks[0];
    const writer = view.agentBlocks[1];
    expect.assert(researcher !== undefined);
    expect.assert(writer !== undefined);
    expect(researcher.ephemeral).toBeUndefined();
    expect(writer.ephemeral).toHaveLength(1);
    expect(writer.ephemeral?.[0]).toEqual({
      type: "text-delta",
      delta: "thinking...",
      id: "eph-1",
    });
  });

  test("accumulates multiple chunks", () => {
    let view = reduceSessionEvent(initialSessionView(), sessionStart());
    view = reduceSessionEvent(view, stepStart());
    view = reduceSessionEvent(view, ephemeralChunk());
    view = reduceSessionEvent(
      view,
      ephemeralChunk({ chunk: { type: "text-delta", delta: "still thinking...", id: "eph-2" } }),
    );

    const block = view.agentBlocks[0];
    expect.assert(block !== undefined);
    expect(block.ephemeral).toHaveLength(2);
  });

  test("ignores ephemeral for unknown stepNumber (no crash)", () => {
    let view = reduceSessionEvent(initialSessionView(), sessionStart());
    // No step started — ephemeral for stepNumber 99
    view = reduceSessionEvent(view, ephemeralChunk({ stepNumber: 99 }));
    // Should not crash, no blocks modified
    expect(view.agentBlocks).toHaveLength(0);
  });

  test("skips pending blocks (stepNumber undefined !== number)", () => {
    let view = reduceSessionEvent(
      initialSessionView(),
      sessionStart({
        plannedSteps: [{ agentName: "researcher", task: "research", actionType: "agent" }],
      }),
    );

    // Pending block has stepNumber: undefined, ephemeral chunk has stepNumber: 1
    view = reduceSessionEvent(view, ephemeralChunk({ stepNumber: 1 }));

    // Pending block should not receive ephemeral
    const pendingBlock = view.agentBlocks[0];
    expect.assert(pendingBlock !== undefined);
    expect(pendingBlock.ephemeral).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Immutability
// ---------------------------------------------------------------------------

describe("immutability", () => {
  test("returns a new object, does not mutate input", () => {
    const view1 = initialSessionView();
    const view2 = reduceSessionEvent(view1, sessionStart());

    expect(view1).not.toBe(view2);
    expect(view1.sessionId).toBe("");
    expect(view2.sessionId).toBe("sess-1");
  });

  test("does not mutate agentBlocks array", () => {
    let view = reduceSessionEvent(initialSessionView(), sessionStart());
    const blocksRef = view.agentBlocks;
    view = reduceSessionEvent(view, stepStart());
    expect(blocksRef).toHaveLength(0); // original unchanged
    expect(view.agentBlocks).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// buildSessionView (convenience)
// ---------------------------------------------------------------------------

describe("buildSessionView", () => {
  test("reduces a full event sequence to SessionView", () => {
    const events = [sessionStart(), stepStart(), stepComplete(), sessionComplete()];

    const view = buildSessionView(events);

    expect(view.sessionId).toBe("sess-1");
    expect(view.status).toBe("completed");
    expect(view.agentBlocks).toHaveLength(1);
    const block = view.agentBlocks[0];
    expect.assert(block !== undefined);
    expect(block.status).toBe("completed");
    expect(view.durationMs).toBe(5000);
  });

  test("handles multi-step sessions", () => {
    const events = [
      sessionStart(),
      stepStart({ stepNumber: 1, agentName: "researcher" }),
      stepComplete({ stepNumber: 1 }),
      stepStart({ stepNumber: 2, agentName: "writer" }),
      stepComplete({ stepNumber: 2, durationMs: 2000 }),
      sessionComplete({ durationMs: 7000 }),
    ];

    const view = buildSessionView(events);

    expect(view.agentBlocks).toHaveLength(2);
    const researcherBlock = view.agentBlocks[0];
    const writerBlock = view.agentBlocks[1];
    expect.assert(researcherBlock !== undefined);
    expect.assert(writerBlock !== undefined);
    expect(researcherBlock.agentName).toBe("researcher");
    expect(writerBlock.agentName).toBe("writer");
    expect(view.durationMs).toBe(7000);
  });

  test("handles empty event array", () => {
    const view = buildSessionView([]);
    expect(view).toEqual(initialSessionView());
  });
});
