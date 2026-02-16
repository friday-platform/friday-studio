import { describe, expect, it } from "vitest";
import { parsePrepareResult } from "../fsm-engine.ts";
import type { AgentAction, Context, FSMDefinition } from "../types.ts";
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
});
