import { describe, expect, it } from "vitest";
import type { AgentAction, Context, FSMDefinition, SignalWithContext } from "../types.ts";
import { createTestEngine } from "./lib/test-utils.ts";

describe("Multi-step FSM: second agent receives full signal context", () => {
  it("cascaded ADVANCE carries _context to second agent's agentExecutor call", async () => {
    const capturedSignals: SignalWithContext[] = [];
    const capturedContexts: Context[] = [];
    const capturedAgentIds: string[] = [];

    const fsm: FSMDefinition = {
      id: "two-agent-pipeline",
      initial: "idle",
      states: {
        idle: { on: { TRIGGER: { target: "step_plan" } } },
        step_plan: {
          entry: [
            { type: "code", function: "prepare_plan" },
            { type: "agent", agentId: "planner", outputTo: "plan-output" },
            { type: "emit", event: "ADVANCE" },
          ],
          on: { ADVANCE: { target: "step_dispatch" } },
        },
        step_dispatch: {
          entry: [
            { type: "code", function: "prepare_dispatch" },
            { type: "agent", agentId: "dispatcher", outputTo: "dispatch-output" },
            { type: "emit", event: "DONE" },
          ],
          on: { DONE: { target: "completed" } },
        },
        completed: { type: "final" },
      },
      functions: {
        prepare_plan: {
          type: "action" as const,
          code: `export default function prepare_plan() {
            return { task: "Plan the work", config: { platformUrl: "http://localhost:8080", role: "planner" } };
          }`,
        },
        prepare_dispatch: {
          type: "action" as const,
          code: `export default function prepare_dispatch(context) {
            return { task: "Dispatch the plan", config: { platformUrl: "http://localhost:8080", role: "dispatcher" } };
          }`,
        },
      },
    };

    const { store, scope } = await createTestEngine(fsm, { initialState: "idle" });

    const { FSMEngine } = await import("../fsm-engine.ts");
    const engine = new FSMEngine(fsm, {
      documentStore: store,
      scope,
      agentExecutor: (action: AgentAction, ctx: Context, sig: SignalWithContext) => {
        capturedAgentIds.push(action.agentId);
        capturedContexts.push(ctx);
        capturedSignals.push(sig);
        return Promise.resolve({
          agentId: action.agentId,
          timestamp: new Date().toISOString(),
          input: "",
          ok: true as const,
          data: { response: "done" },
          durationMs: 0,
        });
      },
    });
    await engine.initialize();

    const onStreamEvent = () => {};
    const onEvent = () => {};

    await engine.signal(
      { type: "TRIGGER", data: { streamId: "chat-123" } },
      { sessionId: "session-1", workspaceId: "ws-1", onEvent, onStreamEvent },
    );

    expect(capturedAgentIds).toEqual(["planner", "dispatcher"]);

    // First agent (planner): should have full context
    const plannerSig = capturedSignals[0];
    expect(plannerSig?._context).toBeDefined();
    expect(plannerSig?._context?.sessionId).toBe("session-1");
    expect(plannerSig?._context?.workspaceId).toBe("ws-1");
    expect(plannerSig?._context?.onStreamEvent).toBe(onStreamEvent);
    expect(plannerSig?._context?.onEvent).toBe(onEvent);

    const plannerCtx = capturedContexts[0];
    expect(plannerCtx?.input?.config).toMatchObject({
      platformUrl: "http://localhost:8080",
      role: "planner",
    });

    // Second agent (dispatcher): should ALSO have full context
    const dispatcherSig = capturedSignals[1];
    expect(dispatcherSig?._context).toBeDefined();
    expect(dispatcherSig?._context?.sessionId).toBe("session-1");
    expect(dispatcherSig?._context?.workspaceId).toBe("ws-1");
    expect(dispatcherSig?._context?.onStreamEvent).toBe(onStreamEvent);
    expect(dispatcherSig?._context?.onEvent).toBe(onEvent);

    const dispatcherCtx = capturedContexts[1];
    expect(dispatcherCtx?.input?.config).toMatchObject({
      platformUrl: "http://localhost:8080",
      role: "dispatcher",
    });
  });

  it("signal.data propagates to cascaded signal (streamId available)", async () => {
    const capturedSignals: SignalWithContext[] = [];

    const fsm: FSMDefinition = {
      id: "data-propagation",
      initial: "idle",
      states: {
        idle: { on: { TRIGGER: { target: "step_a" } } },
        step_a: {
          entry: [
            { type: "code", function: "prep" },
            { type: "agent", agentId: "agent-a" },
            { type: "emit", event: "NEXT" },
          ],
          on: { NEXT: { target: "step_b" } },
        },
        step_b: {
          entry: [
            { type: "code", function: "prep" },
            { type: "agent", agentId: "agent-b" },
          ],
          on: {},
        },
      },
      functions: {
        prep: {
          type: "action" as const,
          code: `export default function prep() { return { task: "work", config: { key: "val" } }; }`,
        },
      },
    };

    const { store, scope } = await createTestEngine(fsm, { initialState: "idle" });
    const { FSMEngine } = await import("../fsm-engine.ts");
    const engine = new FSMEngine(fsm, {
      documentStore: store,
      scope,
      agentExecutor: (_action: AgentAction, _ctx: Context, sig: SignalWithContext) => {
        capturedSignals.push(sig);
        return Promise.resolve({
          agentId: _action.agentId,
          timestamp: new Date().toISOString(),
          input: "",
          ok: true as const,
          data: { response: "done" },
          durationMs: 0,
        });
      },
    });
    await engine.initialize();

    await engine.signal(
      { type: "TRIGGER", data: { streamId: "stream-abc", datetime: { tz: "UTC" } } },
      { sessionId: "s1", workspaceId: "w1", onStreamEvent: () => {} },
    );

    expect(capturedSignals).toHaveLength(2);

    // Both agents should see the original signal data (streamId, datetime)
    expect(capturedSignals[0]?.data).toMatchObject({ streamId: "stream-abc" });
    expect(capturedSignals[1]?.data).toMatchObject({ streamId: "stream-abc" });

    // Both should have _context
    expect(capturedSignals[1]?._context?.sessionId).toBe("s1");
    expect(capturedSignals[1]?._context?.onStreamEvent).toBeDefined();
  });
});
