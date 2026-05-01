import type { JobSpecification } from "@atlas/config";
import { FSMDefinitionSchema } from "@atlas/fsm-engine";
import { describe, expect, it } from "vitest";
import { compileExecutionToFsm, ExecutionCompileError } from "./execution-to-fsm.ts";

function baseJob(overrides: Partial<JobSpecification> = {}): JobSpecification {
  return {
    triggers: [{ signal: "save" }],
    execution: { strategy: "sequential", agents: ["writer"] },
    ...overrides,
  } as JobSpecification;
}

describe("compileExecutionToFsm", () => {
  it("produces a valid FSM for a single-agent sequential job", () => {
    const fsm = compileExecutionToFsm("save_entry", baseJob());

    // Regression for the primary bug: a knowledge-base workspace used
    // this exact shape (one trigger, one agent) and the runtime silently
    // skipped it, returning 404 when Friday dispatched `save`.
    const parsed = FSMDefinitionSchema.parse(fsm);
    expect(parsed.id).toBe("save_entry-sequential");
    expect(parsed.initial).toBe("idle");
    expect(parsed.states).toHaveProperty("idle");
    expect(parsed.states).toHaveProperty("step_0_writer");
    expect(parsed.states).toHaveProperty("completed");
    expect(parsed.states.completed?.type).toBe("final");
  });

  it("wires the trigger signal from idle to the first step", () => {
    const fsm = compileExecutionToFsm("save_entry", baseJob());
    const idle = fsm.states.idle;
    expect(idle?.on).toBeDefined();
    const transition = idle?.on?.save;
    expect(transition && !Array.isArray(transition) && transition.target).toBe("step_0_writer");
  });

  it("chains multiple agents in order with ADVANCE transitions", () => {
    const fsm = compileExecutionToFsm("pipeline", {
      triggers: [{ signal: "go" }],
      execution: { strategy: "sequential", agents: ["a", "b", "c"] },
    } as JobSpecification);

    FSMDefinitionSchema.parse(fsm); // schema-valid
    expect(Object.keys(fsm.states).sort()).toEqual([
      "completed",
      "idle",
      "step_0_a",
      "step_1_b",
      "step_2_c",
    ]);
    const stepA = fsm.states.step_0_a;
    const stepB = fsm.states.step_1_b;
    const stepC = fsm.states.step_2_c;
    expect(stepA?.entry?.[0]).toMatchObject({ type: "agent", agentId: "a" });
    expect(stepA?.on?.ADVANCE).toMatchObject({ target: "step_1_b" });
    expect(stepB?.on?.ADVANCE).toMatchObject({ target: "step_2_c" });
    expect(stepC?.on?.ADVANCE).toMatchObject({ target: "completed" });
  });

  it("accepts detailed agent entries and normalizes to id", () => {
    const fsm = compileExecutionToFsm("detailed", {
      triggers: [{ signal: "go" }],
      execution: { strategy: "sequential", agents: [{ id: "writer", nickname: "scribe" }] },
    } as JobSpecification);
    expect(fsm.states.step_0_writer?.entry?.[0]).toMatchObject({
      type: "agent",
      agentId: "writer",
    });
  });

  it("sanitizes agent ids with unusual characters into safe state names", () => {
    const fsm = compileExecutionToFsm("weird", {
      triggers: [{ signal: "go" }],
      execution: { strategy: "sequential", agents: ["ns/agent:v1"] },
    } as JobSpecification);
    expect(fsm.states).toHaveProperty("step_0_ns_agent_v1");
  });

  it("throws ExecutionCompileError for parallel strategy", () => {
    expect(() =>
      compileExecutionToFsm("pipe", {
        triggers: [{ signal: "go" }],
        execution: { strategy: "parallel", agents: ["a", "b"] },
      } as JobSpecification),
    ).toThrow(ExecutionCompileError);
  });

  it("throws ExecutionCompileError when no execution block is present", () => {
    expect(() =>
      compileExecutionToFsm("fsm-job", { triggers: [{ signal: "go" }] } as JobSpecification),
    ).toThrow(/no 'execution' block/);
  });

  it("throws ExecutionCompileError when execution.agents is empty", () => {
    expect(() =>
      compileExecutionToFsm("empty", {
        triggers: [{ signal: "go" }],
        execution: { strategy: "sequential", agents: [] as never[] },
      } as never),
    ).toThrow(/execution\.agents is empty/);
  });

  it("throws ExecutionCompileError when the job has no triggers", () => {
    expect(() =>
      compileExecutionToFsm("no-trigger", {
        execution: { strategy: "sequential", agents: ["writer"] },
      } as JobSpecification),
    ).toThrow(/no 'triggers'/);
  });

  it("is pure — does not mutate the input jobSpec", () => {
    const job = baseJob();
    const snapshot = JSON.parse(JSON.stringify(job));
    compileExecutionToFsm("save_entry", job);
    expect(job).toEqual(snapshot);
  });
});
