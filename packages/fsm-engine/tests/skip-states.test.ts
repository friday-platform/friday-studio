import { describe, expect, it } from "vitest";
import type { FSMDefinition, FSMEvent } from "../types.ts";
import { createTestEngine } from "./lib/test-utils.ts";

/**
 * Linear pipeline FSM for skip-states tests.
 * A → B → C → done(final)
 * Each non-final state emits an entry event to track execution.
 */
const linearPipelineFSM: FSMDefinition = {
  id: "skip-test",
  initial: "A",
  states: {
    A: { entry: [{ type: "emit", event: "entry_A" }], on: { ADVANCE: { target: "B" } } },
    B: { entry: [{ type: "emit", event: "entry_B" }], on: { ADVANCE: { target: "C" } } },
    C: { entry: [{ type: "emit", event: "entry_C" }], on: { ADVANCE: { target: "done" } } },
    done: { type: "final" },
  },
};

describe("FSM Engine - skipStates", () => {
  it("skips a single state: skipStates ['C'] causes B to transition directly to done", async () => {
    const { engine } = await createTestEngine(linearPipelineFSM);

    // Advance A → B (normal)
    await engine.signal(
      { type: "ADVANCE" },
      { sessionId: "s1", workspaceId: "ws", skipStates: ["C"] },
    );
    expect(engine.state).toEqual("B");

    // Advance B → should skip C → land on done
    await engine.signal(
      { type: "ADVANCE" },
      { sessionId: "s1", workspaceId: "ws", skipStates: ["C"] },
    );
    expect(engine.state).toEqual("done");

    // C's entry action should never have executed
    const entryEvents = engine.emittedEvents.map((e) => e.event);
    expect(entryEvents).not.toContain("entry_C");
  });

  it("skips middle state: skipStates ['B'] causes A to transition to C", async () => {
    const { engine } = await createTestEngine(linearPipelineFSM);

    // Advance A → should skip B → land on C
    await engine.signal(
      { type: "ADVANCE" },
      { sessionId: "s1", workspaceId: "ws", skipStates: ["B"] },
    );
    expect(engine.state).toEqual("C");

    // B's entry action should not have executed
    const entryEvents = engine.emittedEvents.map((e) => e.event);
    expect(entryEvents).not.toContain("entry_B");

    // C's entry action SHOULD have executed
    expect(entryEvents).toContain("entry_C");
  });

  it("chains through multiple skipped states: skipStates ['B', 'C'] goes A → done", async () => {
    const { engine } = await createTestEngine(linearPipelineFSM);

    // Advance A → should skip B and C → land on done
    await engine.signal(
      { type: "ADVANCE" },
      { sessionId: "s1", workspaceId: "ws", skipStates: ["B", "C"] },
    );
    expect(engine.state).toEqual("done");

    // Neither B nor C entry actions should have executed
    const entryEvents = engine.emittedEvents.map((e) => e.event);
    expect(entryEvents).not.toContain("entry_B");
    expect(entryEvents).not.toContain("entry_C");
  });

  it("emits FSMStateSkippedEvent for each skipped state via onEvent", async () => {
    const { engine } = await createTestEngine(linearPipelineFSM);

    const events: FSMEvent[] = [];
    await engine.signal(
      { type: "ADVANCE" },
      {
        sessionId: "s1",
        workspaceId: "ws",
        skipStates: ["B", "C"],
        onEvent: (e) => events.push(e),
      },
    );

    const skipEvents = events.filter((e) => e.type === "data-fsm-state-skipped");
    expect(skipEvents).toHaveLength(2);
    expect(skipEvents[0]?.data.stateId).toEqual("B");
    expect(skipEvents[1]?.data.stateId).toEqual("C");

    // Verify event shape
    for (const evt of skipEvents) {
      expect(evt.data.sessionId).toEqual("s1");
      expect(evt.data.workspaceId).toEqual("ws");
      expect(evt.data.jobName).toEqual("skip-test");
      expect(typeof evt.data.timestamp).toEqual("number");
    }
  });

  it("ignores initial state in skipStates — initial state still receives the trigger signal", async () => {
    const { engine } = await createTestEngine(linearPipelineFSM);

    // Even though A is in skipStates, it should still process the signal normally
    // because A is the initial state and we're sending ADVANCE from A
    await engine.signal(
      { type: "ADVANCE" },
      { sessionId: "s1", workspaceId: "ws", skipStates: ["A"] },
    );

    // Should transition normally from A to B (A is initial, skip is ignored)
    expect(engine.state).toEqual("B");
  });

  it("ignores final state in skipStates", async () => {
    const { engine } = await createTestEngine(linearPipelineFSM);

    // Advance through to C
    await engine.signal({ type: "ADVANCE" });
    await engine.signal({ type: "ADVANCE" });
    expect(engine.state).toEqual("C");

    // Advance C → done, even though "done" is in skipStates
    await engine.signal(
      { type: "ADVANCE" },
      { sessionId: "s1", workspaceId: "ws", skipStates: ["done"] },
    );
    expect(engine.state).toEqual("done");
  });

  it("logs warning for unknown state ID in skipStates and treats as no-op", async () => {
    const { engine } = await createTestEngine(linearPipelineFSM);

    // Signal with unknown state in skipStates — should not throw
    await engine.signal(
      { type: "ADVANCE" },
      { sessionId: "s1", workspaceId: "ws", skipStates: ["nonexistent_state"] },
    );

    // Normal transition A → B (unknown state is no-op)
    expect(engine.state).toEqual("B");
  });

  it("throws when skipped state has multiple outgoing transitions", async () => {
    const branchingFSM: FSMDefinition = {
      id: "branching-test",
      initial: "start",
      states: {
        start: { on: { GO: { target: "brancher" } } },
        brancher: {
          entry: [{ type: "emit", event: "entry_brancher" }],
          on: { LEFT: { target: "left_end" }, RIGHT: { target: "right_end" } },
        },
        left_end: { type: "final" },
        right_end: { type: "final" },
      },
    };

    const { engine } = await createTestEngine(branchingFSM);

    await expect(
      engine.signal(
        { type: "GO" },
        { sessionId: "s1", workspaceId: "ws", skipStates: ["brancher"] },
      ),
    ).rejects.toThrow(/Cannot skip state with 2 outgoing transitions/);
  });

  it("detects circular skip chain and throws", async () => {
    // Circular FSM: A → B → A (both skipped = infinite loop)
    const circularFSM: FSMDefinition = {
      id: "circular-test",
      initial: "entry",
      states: {
        entry: { on: { GO: { target: "A" } } },
        A: { entry: [{ type: "emit", event: "entry_A" }], on: { ADVANCE: { target: "B" } } },
        B: { entry: [{ type: "emit", event: "entry_B" }], on: { ADVANCE: { target: "A" } } },
      },
    };

    const { engine } = await createTestEngine(circularFSM);

    await expect(
      engine.signal({ type: "GO" }, { sessionId: "s1", workspaceId: "ws", skipStates: ["A", "B"] }),
    ).rejects.toThrow(/Circular skip chain detected/);
  });
});
