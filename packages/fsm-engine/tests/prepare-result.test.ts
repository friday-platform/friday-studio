import { describe, expect, it } from "vitest";
import { parsePrepareResult } from "../fsm-engine.ts";
import type { AgentAction, Context, FSMDefinition, SignalWithContext } from "../types.ts";
import { createTestEngine } from "./lib/test-utils.ts";

describe("parsePrepareResult", () => {
  it("parses valid prepare result with task and config", () => {
    const result = parsePrepareResult({ task: "Do the thing", config: { model: "gpt-4" } });
    expect(result).toMatchObject({ task: "Do the thing", config: { model: "gpt-4" } });
  });

  it("returns undefined for null", () => {
    expect(parsePrepareResult(null)).toBeUndefined();
  });

  it("returns undefined for undefined", () => {
    expect(parsePrepareResult(undefined)).toBeUndefined();
  });

  it("returns undefined for non-object", () => {
    expect(parsePrepareResult("hello")).toBeUndefined();
    expect(parsePrepareResult(42)).toBeUndefined();
  });

  it("returns undefined for empty object (neither task nor config)", () => {
    expect(parsePrepareResult({})).toBeUndefined();
  });

  it("returns result with only task", () => {
    const result = parsePrepareResult({ task: "Just a task" });
    expect(result).toMatchObject({ task: "Just a task" });
  });

  it("returns result with only config", () => {
    const result = parsePrepareResult({ config: { key: "val" } });
    expect(result).toMatchObject({ config: { key: "val" } });
  });

  it("passes through extra properties", () => {
    const result = parsePrepareResult({ task: "x", extra: "data" });
    expect(result).toHaveProperty("extra", "data");
  });
});

describe("Engine: emit action behavior", () => {
  it("emit action with explicit data overrides parent signal data", async () => {
    const capturedSignals: { agentId: string; signal: SignalWithContext }[] = [];

    const fsm: FSMDefinition = {
      id: "emit-override",
      initial: "idle",
      states: {
        idle: { on: { trigger: { target: "step_a" } } },
        step_a: {
          entry: [{ type: "emit", event: "NEXT", data: { custom: "override" } }],
          on: { NEXT: { target: "step_b" } },
        },
        step_b: {
          entry: [{ type: "agent", agentId: "worker", outputTo: "result" }],
          type: "final",
        },
      },
    };

    const { store, scope } = await createTestEngine(fsm, { initialState: "idle" });

    const { FSMEngine } = await import("../fsm-engine.ts");
    const engine = new FSMEngine(fsm, {
      documentStore: store,
      scope,
      agentExecutor: (action: AgentAction, _ctx: Context, signal: SignalWithContext) => {
        capturedSignals.push({ agentId: action.agentId, signal });
        return Promise.resolve({
          agentId: action.agentId,
          timestamp: new Date().toISOString(),
          input: "",
          ok: true as const,
          data: { done: true },
          durationMs: 0,
        });
      },
    });
    await engine.initialize();

    await engine.signal(
      { type: "trigger", data: { streamId: "orig-stream" } },
      { sessionId: "s1", workspaceId: "w1" },
    );

    expect(capturedSignals).toHaveLength(1);
    const workerSig = capturedSignals[0];
    expect(workerSig?.signal.data).toMatchObject({ custom: "override" });
    expect(workerSig?.signal.data).not.toHaveProperty("streamId");
  });
});
