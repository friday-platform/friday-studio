import { describe, expect, it } from "vitest";
import { FSMBuilder } from "./builder.ts";

// ---------------------------------------------------------------------------
// onTransitions — transition arrays
// ---------------------------------------------------------------------------

describe("FSMBuilder.onTransitions", () => {
  it("produces TransitionDefinition[] in FSM output", () => {
    const result = new FSMBuilder("test")
      .setInitialState("start")
      .addState("start")
      .onTransitions("ADVANCE", [
        { target: "branch_a", guards: ["check_a"] },
        { target: "branch_b", guards: [] },
      ])
      .addState("branch_a")
      .final()
      .addState("branch_b")
      .final()
      .addFunction("check_a", "guard", "return true;")
      .build();

    expect(result.success).toBe(true);
    if (!result.success) return;

    const startState = result.value.states.start;
    expect(startState?.on?.ADVANCE).toEqual([
      { target: "branch_a", guards: ["check_a"] },
      { target: "branch_b" },
    ]);
  });

  it("validates guard references in transition arrays", () => {
    const result = new FSMBuilder("test")
      .setInitialState("start")
      .addState("start")
      .onTransitions("ADVANCE", [{ target: "done", guards: ["nonexistent_guard"] }])
      .addState("done")
      .final()
      .build();

    expect(result.success).toBe(false);
    if (result.success) return;

    expect(result.error).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "invalid_guard_reference",
          context: expect.objectContaining({ guardName: "nonexistent_guard" }),
        }),
      ]),
    );
  });

  it("validates target state references in transition arrays", () => {
    const result = new FSMBuilder("test")
      .setInitialState("start")
      .addState("start")
      .onTransitions("ADVANCE", [{ target: "nonexistent_state", guards: [] }])
      .build();

    expect(result.success).toBe(false);
    if (result.success) return;

    expect(result.error).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "invalid_state_reference",
          context: expect.objectContaining({ targetState: "nonexistent_state" }),
        }),
      ]),
    );
  });

  it("rejects guard that is actually an action", () => {
    const result = new FSMBuilder("test")
      .setInitialState("start")
      .addState("start")
      .onTransitions("ADVANCE", [{ target: "done", guards: ["my_action"] }])
      .addState("done")
      .final()
      .addFunction("my_action", "action", "return;")
      .build();

    expect(result.success).toBe(false);
    if (result.success) return;

    expect(result.error).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "invalid_guard_reference",
          message: expect.stringContaining("action, not a guard"),
        }),
      ]),
    );
  });

  it("errors when called without state context", () => {
    const result = new FSMBuilder("test")
      .setInitialState("start")
      .onTransitions("ADVANCE", [{ target: "done", guards: [] }])
      .addState("start")
      .onTransition("ADVANCE", "done")
      .addState("done")
      .final()
      .build();

    expect(result.success).toBe(false);
    if (result.success) return;

    expect(result.error).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "no_state_context" })]),
    );
  });
});

// ---------------------------------------------------------------------------
// Existing single-transition behavior (regression)
// ---------------------------------------------------------------------------

describe("FSMBuilder.onTransition — single transition unchanged", () => {
  it("produces single TransitionDefinition (not array)", () => {
    const result = new FSMBuilder("test")
      .setInitialState("start")
      .addState("start")
      .onTransition("ADVANCE", "done")
      .addState("done")
      .final()
      .build();

    expect(result.success).toBe(true);
    if (!result.success) return;

    const startState = result.value.states.start;
    // Single transition — NOT wrapped in array
    expect(startState?.on?.ADVANCE).toEqual({ target: "done" });
    expect(Array.isArray(startState?.on?.ADVANCE)).toBe(false);
  });
});
