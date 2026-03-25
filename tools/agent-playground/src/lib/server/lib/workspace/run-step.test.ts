import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildFSMFromPlan, WorkspaceBlueprintSchema } from "@atlas/workspace-builder";
import { describe, expect, it } from "vitest";
import { runStep } from "./run-step.ts";

// ---------------------------------------------------------------------------
// Fixture: load stable fixture and compile FSM deterministically
// ---------------------------------------------------------------------------

if (!import.meta.dirname) throw new Error("import.meta.dirname unavailable");
const fixturePath = resolve(
  import.meta.dirname,
  "../../../../../../../packages/workspace-builder/fixtures/csv-analysis-plan.json",
);
const phase3 = WorkspaceBlueprintSchema.parse(JSON.parse(readFileSync(fixturePath, "utf-8")));
const firstJob = phase3.jobs[0];
if (!firstJob) throw new Error("No jobs in fixture");
const compiled = buildFSMFromPlan(firstJob);
if (!compiled.success) throw new Error("Failed to compile FSM from fixture");
const fsm = compiled.value.fsm;

// Find a step state to test with (first non-idle, non-completed state)
const stepStates = Object.keys(fsm.states).filter(
  (s) => s !== "idle" && s !== "completed" && s.startsWith("step_"),
);
const testStateId = stepStates[0];
if (!testStateId) throw new Error("No step states found in fixture FSM");

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runStep — single step execution", () => {
  it("executes a valid step state and returns success", async () => {
    const result = await runStep({
      fsm,
      plan: phase3,
      stateId: testStateId,
      input: {},
    });

    expect(result.success).toBe(true);
    expect(result.output).toBeDefined();
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.error).toBeUndefined();
  });

  it("returns error for nonexistent state", async () => {
    const result = await runStep({
      fsm,
      plan: phase3,
      stateId: "step_nonexistent_state",
      input: {},
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("not found");
  });

  it("returns error for state without agent action (idle)", async () => {
    const result = await runStep({
      fsm,
      plan: phase3,
      stateId: "idle",
      input: {},
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("No agent action");
  });

  it("passes input through to the executor", async () => {
    const actions: Array<{ status: string; input?: unknown }> = [];

    const result = await runStep({
      fsm,
      plan: phase3,
      stateId: testStateId,
      input: { query: "test input data" },
      onAction: (action) => {
        actions.push({ status: action.status, input: action.input });
      },
    });

    expect(result.success).toBe(true);
    // Should have at least started and completed callbacks
    expect(actions.length).toBeGreaterThanOrEqual(2);
    const started = actions.find((a) => a.status === "started");
    expect(started).toBeDefined();
    const completed = actions.find((a) => a.status === "completed");
    expect(completed).toBeDefined();
  });
});
