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

describe("Engine: code action return values as context.input", () => {
  it("captures code action return value and provides as context.input on subsequent agent action", async () => {
    let capturedContext: Context | undefined;

    const fsm: FSMDefinition = {
      id: "prepare-flow",
      initial: "idle",
      states: {
        idle: {
          on: {
            START: {
              target: "working",
              actions: [
                { type: "code", function: "prepare" },
                { type: "agent", agentId: "worker" },
              ],
            },
          },
        },
        working: { type: "final" },
      },
      functions: {
        prepare: {
          type: "action",
          code: `export default function prepare() { return { task: "Analyze data", config: { model: "gpt-4" } }; }`,
        },
      },
    };

    const { store, scope } = await createTestEngine(fsm, { initialState: "idle" });

    const { FSMEngine } = await import("../fsm-engine.ts");
    const engine = new FSMEngine(fsm, {
      documentStore: store,
      scope,
      agentExecutor: (action: AgentAction, ctx: Context) => {
        capturedContext = ctx;
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

    await engine.signal({ type: "START" });

    expect(capturedContext).toBeDefined();
    expect(capturedContext?.input).toMatchObject({
      task: "Analyze data",
      config: { model: "gpt-4" },
    });
  });

  it("code action returning undefined leaves input absent", async () => {
    let capturedContext: Context | undefined;

    const fsm: FSMDefinition = {
      id: "no-return-flow",
      initial: "idle",
      states: {
        idle: {
          on: {
            START: {
              target: "done",
              actions: [
                { type: "code", function: "noop" },
                { type: "agent", agentId: "worker" },
              ],
            },
          },
        },
        done: { type: "final" },
      },
      functions: { noop: { type: "action", code: `export default function noop() {}` } },
    };

    const { store, scope } = await createTestEngine(fsm, { initialState: "idle" });

    const { FSMEngine } = await import("../fsm-engine.ts");
    const engine = new FSMEngine(fsm, {
      documentStore: store,
      scope,
      agentExecutor: (action: AgentAction, ctx: Context) => {
        capturedContext = ctx;
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

    await engine.signal({ type: "START" });

    expect(capturedContext).toBeDefined();
    expect(capturedContext?.input).toBeUndefined();
  });

  it("code action returning empty object leaves input absent", async () => {
    let capturedContext: Context | undefined;

    const fsm: FSMDefinition = {
      id: "empty-return-flow",
      initial: "idle",
      states: {
        idle: {
          on: {
            START: {
              target: "done",
              actions: [
                { type: "code", function: "emptyReturn" },
                { type: "agent", agentId: "worker" },
              ],
            },
          },
        },
        done: { type: "final" },
      },
      functions: {
        emptyReturn: {
          type: "action",
          code: `export default function emptyReturn() { return {}; }`,
        },
      },
    };

    const { store, scope } = await createTestEngine(fsm, { initialState: "idle" });

    const { FSMEngine } = await import("../fsm-engine.ts");
    const engine = new FSMEngine(fsm, {
      documentStore: store,
      scope,
      agentExecutor: (action: AgentAction, ctx: Context) => {
        capturedContext = ctx;
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

    await engine.signal({ type: "START" });

    expect(capturedContext).toBeDefined();
    expect(capturedContext?.input).toBeUndefined();
  });

  it("prepare result is scoped to current executeActions call (no cross-state leakage)", async () => {
    const capturedContexts: Context[] = [];

    const fsm: FSMDefinition = {
      id: "scope-test",
      initial: "first",
      states: {
        first: {
          on: {
            GO: {
              target: "second",
              actions: [
                { type: "code", function: "prepare" },
                { type: "agent", agentId: "worker" },
              ],
            },
          },
        },
        second: {
          on: { GO_AGAIN: { target: "done", actions: [{ type: "agent", agentId: "worker" }] } },
        },
        done: { type: "final" },
      },
      functions: {
        prepare: {
          type: "action",
          code: `export default function prepare() { return { task: "First task" }; }`,
        },
      },
    };

    const { store, scope } = await createTestEngine(fsm, { initialState: "first" });

    const { FSMEngine } = await import("../fsm-engine.ts");
    const engine = new FSMEngine(fsm, {
      documentStore: store,
      scope,
      agentExecutor: (action: AgentAction, ctx: Context) => {
        capturedContexts.push(ctx);
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

    // First transition: prepare -> agent (input present)
    await engine.signal({ type: "GO" });
    // Second transition: agent only (no prepare, input absent)
    await engine.signal({ type: "GO_AGAIN" });

    expect(capturedContexts).toHaveLength(2);
    expect(capturedContexts[0]?.input).toMatchObject({ task: "First task" });
    expect(capturedContexts[1]?.input).toBeUndefined();
  });

  it("malformed return is ignored, input is undefined", async () => {
    let capturedContext: Context | undefined;
    const fsm: FSMDefinition = {
      id: "malformed-flow",
      initial: "idle",
      states: {
        idle: {
          on: {
            START: {
              target: "done",
              actions: [
                { type: "code", function: "badReturn" },
                { type: "agent", agentId: "worker" },
              ],
            },
          },
        },
        done: { type: "final" },
      },
      functions: {
        badReturn: {
          type: "action",
          // Returns a non-object (number) - should be caught by Zod parse
          code: `export default function badReturn() { return 42; }`,
        },
      },
    };

    const { store, scope } = await createTestEngine(fsm, { initialState: "idle" });

    const { FSMEngine } = await import("../fsm-engine.ts");
    const engine = new FSMEngine(fsm, {
      documentStore: store,
      scope,
      agentExecutor: (action: AgentAction, ctx: Context) => {
        capturedContext = ctx;
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

    await engine.signal({ type: "START" });

    expect(capturedContext).toBeDefined();
    expect(capturedContext?.input).toBeUndefined();
  });

  it("agent executor callback receives input field in context", async () => {
    let capturedContext: Context | undefined;

    const fsm: FSMDefinition = {
      id: "input-in-context",
      initial: "idle",
      states: {
        idle: {
          on: {
            START: {
              target: "done",
              actions: [
                { type: "code", function: "prepare" },
                { type: "agent", agentId: "worker" },
              ],
            },
          },
        },
        done: { type: "final" },
      },
      functions: {
        prepare: {
          type: "action",
          code: `export default function prepare() { return { task: "Build report", config: { format: "pdf" } }; }`,
        },
      },
    };

    const { store, scope } = await createTestEngine(fsm, { initialState: "idle" });

    const { FSMEngine } = await import("../fsm-engine.ts");
    const engine = new FSMEngine(fsm, {
      documentStore: store,
      scope,
      agentExecutor: (action: AgentAction, ctx: Context) => {
        capturedContext = ctx;
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

    await engine.signal({ type: "START" });

    expect(capturedContext).toBeDefined();
    expect(capturedContext).toHaveProperty("input");
    expect(capturedContext?.input).toMatchObject({
      task: "Build report",
      config: { format: "pdf" },
    });
    // Verify other context fields still present
    expect(capturedContext).toHaveProperty("documents");
    expect(capturedContext).toHaveProperty("state");
  });

  it("second agent in same action sequence preserves prepare context", async () => {
    const capturedContexts: { agentId: string; ctx: Context }[] = [];

    const fsm: FSMDefinition = {
      id: "two-agent-sequence",
      initial: "idle",
      states: {
        idle: {
          on: {
            START: {
              target: "done",
              actions: [
                { type: "code", function: "prepare" },
                { type: "agent", agentId: "planner", outputTo: "plan_result" },
                { type: "agent", agentId: "dispatcher", outputTo: "dispatch_result" },
              ],
            },
          },
        },
        done: { type: "final" },
      },
      functions: {
        prepare: {
          type: "action",
          code: `export default function prepare() { return { task: "Plan and dispatch", config: { workDir: "/workspace/atlas", stream: true } }; }`,
        },
      },
    };

    const { store, scope } = await createTestEngine(fsm, { initialState: "idle" });

    const { FSMEngine } = await import("../fsm-engine.ts");
    const engine = new FSMEngine(fsm, {
      documentStore: store,
      scope,
      agentExecutor: (action: AgentAction, ctx: Context) => {
        capturedContexts.push({ agentId: action.agentId, ctx });
        return Promise.resolve({
          agentId: action.agentId,
          timestamp: new Date().toISOString(),
          input: "",
          ok: true as const,
          data: { response: `${action.agentId} done` },
          durationMs: 0,
        });
      },
    });
    await engine.initialize();

    await engine.signal({ type: "START" });

    expect(capturedContexts).toHaveLength(2);

    const plannerCtx = capturedContexts.find((c) => c.agentId === "planner");
    const dispatcherCtx = capturedContexts.find((c) => c.agentId === "dispatcher");

    expect(plannerCtx).toBeDefined();
    expect(dispatcherCtx).toBeDefined();

    expect(plannerCtx?.ctx.input).toMatchObject({
      task: "Plan and dispatch",
      config: { workDir: "/workspace/atlas", stream: true },
    });

    expect(dispatcherCtx?.ctx.input).toMatchObject({
      task: "Plan and dispatch",
      config: { workDir: "/workspace/atlas", stream: true },
    });
  });

  it("second agent sees first agent results but keeps prepare input", async () => {
    const capturedContexts: { agentId: string; ctx: Context }[] = [];

    const fsm: FSMDefinition = {
      id: "two-agent-results",
      initial: "idle",
      states: {
        idle: {
          on: {
            START: {
              target: "done",
              actions: [
                { type: "code", function: "prepare" },
                { type: "agent", agentId: "planner", outputTo: "plan_result" },
                { type: "agent", agentId: "dispatcher", outputTo: "dispatch_result" },
              ],
            },
          },
        },
        done: { type: "final" },
      },
      functions: {
        prepare: {
          type: "action",
          code: `export default function prepare() { return { task: "Execute pipeline", config: { httpEndpoint: "http://localhost:8080" } }; }`,
        },
      },
    };

    const { store, scope } = await createTestEngine(fsm, { initialState: "idle" });

    const { FSMEngine } = await import("../fsm-engine.ts");
    const engine = new FSMEngine(fsm, {
      documentStore: store,
      scope,
      agentExecutor: (action: AgentAction, ctx: Context) => {
        capturedContexts.push({ agentId: action.agentId, ctx });
        return Promise.resolve({
          agentId: action.agentId,
          timestamp: new Date().toISOString(),
          input: "",
          ok: true as const,
          data: { summary: `${action.agentId} completed` },
          durationMs: 0,
        });
      },
    });
    await engine.initialize();

    await engine.signal({ type: "START" });

    expect(capturedContexts).toHaveLength(2);

    const dispatcherCtx = capturedContexts[1];
    expect(dispatcherCtx?.agentId).toBe("dispatcher");
    expect(dispatcherCtx?.ctx.input?.config).toMatchObject({
      httpEndpoint: "http://localhost:8080",
    });
    expect(dispatcherCtx?.ctx.results).toHaveProperty("plan_result");
    expect(dispatcherCtx?.ctx.results.plan_result).toMatchObject({ summary: "planner completed" });
  });

  it("cascaded signal preserves trigger data across separate FSM states", async () => {
    const capturedSignals: { agentId: string; signal: SignalWithContext }[] = [];

    const fsm: FSMDefinition = {
      id: "two-state-agents",
      initial: "idle",
      states: {
        idle: { on: { trigger: { target: "step_plan" } } },
        step_plan: {
          entry: [
            { type: "code", function: "prepare_plan" },
            { type: "agent", agentId: "planner", outputTo: "plan_result" },
            { type: "emit", event: "ADVANCE" },
          ],
          on: { ADVANCE: { target: "step_dispatch" } },
        },
        step_dispatch: {
          entry: [
            { type: "code", function: "prepare_dispatch" },
            { type: "agent", agentId: "dispatcher", outputTo: "dispatch_result" },
          ],
          type: "final",
        },
      },
      functions: {
        prepare_plan: {
          type: "action",
          code: `export default function prepare_plan() { return { task: "Plan the work" }; }`,
        },
        prepare_dispatch: {
          type: "action",
          code: `export default function prepare_dispatch(context) {
            var plan = context.results['plan_result'];
            return { task: "Dispatch: " + (plan ? plan.summary : "no plan"), config: { workDir: "/ws" } };
          }`,
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
          data: { summary: `${action.agentId} done` },
          durationMs: 0,
        });
      },
    });
    await engine.initialize();

    const streamEvents: unknown[] = [];
    await engine.signal(
      { type: "trigger", data: { streamId: "chat-123", datetime: { tz: "America/Los_Angeles" } } },
      {
        sessionId: "sess-1",
        workspaceId: "ws-1",
        onStreamEvent: (chunk) => streamEvents.push(chunk),
      },
    );

    expect(capturedSignals).toHaveLength(2);

    const plannerSig = capturedSignals.find((c) => c.agentId === "planner");
    const dispatcherSig = capturedSignals.find((c) => c.agentId === "dispatcher");

    expect(plannerSig?.signal.data).toMatchObject({
      streamId: "chat-123",
      datetime: { tz: "America/Los_Angeles" },
    });

    expect(dispatcherSig?.signal.data).toMatchObject({
      streamId: "chat-123",
      datetime: { tz: "America/Los_Angeles" },
    });

    expect(dispatcherSig?.signal._context?.sessionId).toBe("sess-1");
    expect(dispatcherSig?.signal._context?.onStreamEvent).toBeDefined();
  });

  it("second agent in separate FSM state receives fresh context with signal bindings", async () => {
    const capturedArgs: { agentId: string; ctx: Context; signal: SignalWithContext }[] = [];

    const fsm: FSMDefinition = {
      id: "cross-state-agent-context",
      initial: "idle",
      states: {
        idle: { on: { trigger: { target: "step_plan" } } },
        step_plan: {
          entry: [
            { type: "code", function: "prepare_plan" },
            { type: "agent", agentId: "planner", outputTo: "plan_result" },
            { type: "emit", event: "ADVANCE" },
          ],
          on: { ADVANCE: { target: "step_dispatch" } },
        },
        step_dispatch: {
          entry: [
            { type: "code", function: "prepare_dispatch" },
            { type: "agent", agentId: "dispatcher", outputTo: "dispatch_result" },
          ],
          type: "final",
        },
      },
      functions: {
        prepare_plan: {
          type: "action",
          code: `export default function prepare_plan() {
            return { task: "Plan the work", config: { workDir: "/ws" } };
          }`,
        },
        prepare_dispatch: {
          type: "action",
          code: `export default function prepare_dispatch(context) {
            var plan = context.results['plan_result'];
            return { task: "Dispatch: " + (plan ? plan.summary : "no plan"), config: { stream: true } };
          }`,
        },
      },
    };

    const { store, scope } = await createTestEngine(fsm, { initialState: "idle" });

    const { FSMEngine } = await import("../fsm-engine.ts");
    const engine = new FSMEngine(fsm, {
      documentStore: store,
      scope,
      agentExecutor: (action: AgentAction, ctx: Context, signal: SignalWithContext) => {
        capturedArgs.push({ agentId: action.agentId, ctx, signal });
        return Promise.resolve({
          agentId: action.agentId,
          timestamp: new Date().toISOString(),
          input: "",
          ok: true as const,
          data: { summary: `${action.agentId} completed` },
          durationMs: 0,
        });
      },
    });
    await engine.initialize();

    const streamChunks: unknown[] = [];
    await engine.signal(
      { type: "trigger", data: { streamId: "s-123", datetime: { tz: "UTC" } } },
      {
        sessionId: "sess-ctx",
        workspaceId: "ws-ctx",
        onStreamEvent: (chunk) => streamChunks.push(chunk),
      },
    );

    expect(capturedArgs).toHaveLength(2);

    const planner = capturedArgs.find((c) => c.agentId === "planner");
    const dispatcher = capturedArgs.find((c) => c.agentId === "dispatcher");

    // --- Planner (first agent, first state) ---
    expect(planner?.ctx.state).toBe("step_plan");
    expect(planner?.ctx.input).toMatchObject({ task: "Plan the work", config: { workDir: "/ws" } });
    expect(planner?.signal._context?.sessionId).toBe("sess-ctx");
    expect(planner?.signal._context?.onStreamEvent).toBeDefined();

    // --- Dispatcher (second agent, second state via cascaded signal) ---
    // Context must be fresh — not a stale closure from the planner's state
    expect(dispatcher?.ctx.state).toBe("step_dispatch");
    expect(dispatcher?.ctx.input).toMatchObject({
      task: "Dispatch: planner completed",
      config: { stream: true },
    });
    // Must see planner's output in results
    expect(dispatcher?.ctx.results).toHaveProperty("plan_result");
    expect(dispatcher?.ctx.results.plan_result).toMatchObject({ summary: "planner completed" });
    // emit must be a function (not stripped)
    expect(typeof dispatcher?.ctx.emit).toBe("function");
    // Signal bindings must survive the state transition (the core bug being tested)
    expect(dispatcher?.signal._context?.sessionId).toBe("sess-ctx");
    expect(dispatcher?.signal._context?.workspaceId).toBe("ws-ctx");
    expect(dispatcher?.signal._context?.onStreamEvent).toBeDefined();
    // Signal data falls back to parent trigger data
    expect(dispatcher?.signal.data).toMatchObject({ streamId: "s-123", datetime: { tz: "UTC" } });
  });

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
