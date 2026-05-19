import { Buffer } from "node:buffer";
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

  it("returns undefined for empty object (neither task nor config nor webhook fields)", () => {
    expect(parsePrepareResult({})).toBeUndefined();
  });

  it("keeps result with only body+headers (webhook-only, no task/config)", () => {
    // Pass-4 fix #2: parsePrepareResult used to return undefined when
    // task+config were both null even if body/headers were set. That
    // broke `__lastPrepare` carryover for webhook-triggered signals
    // where the seed had body/headers but a downstream code action
    // returned no structural data — silently dropping the HMAC
    // material on the next state's read.
    const result = parsePrepareResult({
      body: "ZGVhZGJlZWY=", // base64 webhook bytes
      headers: { "x-github-event": "pull_request" },
    });
    expect(result).toBeDefined();
    expect(result?.body).toBe("ZGVhZGJlZWY=");
    expect(result?.headers).toEqual({ "x-github-event": "pull_request" });
  });

  it("keeps result with only body (no headers, no task, no config)", () => {
    const result = parsePrepareResult({ body: "abc" });
    expect(result).toBeDefined();
    expect(result?.body).toBe("abc");
  });

  it("keeps result with only headers (no body, no task, no config)", () => {
    const result = parsePrepareResult({ headers: { "x-trace-id": "t1" } });
    expect(result).toBeDefined();
    expect(result?.headers).toEqual({ "x-trace-id": "t1" });
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

describe("Engine: webhook body/headers preservation across actions", () => {
  // Regression for pass-3 review #1. The seed at fsm-engine.ts ~1082 sets
  // body/headers on the first prepareResult from sig. The bug: when a
  // downstream action declares `inputFrom`, the merge at ~1152 used to
  // spread `inputSnapshot` (which doesn't carry body/headers — it's
  // computed from document data only) on top of the upstream
  // prepareResult, overwriting body/headers with undefined. So a two-
  // state HMAC-verifying job (validate → process) would see
  // ctx.input.raw["body"] in the FIRST agent but `undefined` in the
  // SECOND. The fix at ~1152 preserves body/headers explicitly during
  // the inputFrom merge.
  it("preserves sig.body / sig.headers across an inputFrom merge", async () => {
    const captured: Array<{ stateId: string; input: Context["input"] }> = [];

    const fsm: FSMDefinition = {
      id: "webhook-two-state",
      initial: "idle",
      states: {
        idle: { on: { "gh-pr-comment": { target: "verify" } } },
        verify: {
          entry: [{ type: "agent", agentId: "verifier", outputTo: "verify-result" }],
          on: { VERIFIED: { target: "process" } },
        },
        process: {
          // This is the action that previously dropped body/headers.
          entry: [
            {
              type: "agent",
              agentId: "processor",
              outputTo: "process-result",
              inputFrom: "verify-result",
            },
          ],
          type: "final",
        },
      },
      documentTypes: {
        "verify-result": { type: "object", properties: { valid: { type: "boolean" } } },
        "process-result": { type: "object", properties: { done: { type: "boolean" } } },
      },
    };

    const { store, scope } = await createTestEngine(fsm, { initialState: "idle" });
    const { FSMEngine } = await import("../fsm-engine.ts");
    const engine = new FSMEngine(fsm, {
      documentStore: store,
      scope,
      agentExecutor: async (action: AgentAction, ctx: Context, _signal: SignalWithContext) => {
        captured.push({ stateId: ctx.state, input: ctx.input });
        // Verifier emits the transition trigger so the FSM advances to
        // the `process` state — which is where the previously-broken
        // inputFrom merge runs.
        if (action.agentId === "verifier") {
          await ctx.emit?.({ type: "VERIFIED" });
        }
        return {
          agentId: action.agentId,
          timestamp: new Date().toISOString(),
          input: "",
          ok: true as const,
          data: { done: true },
          durationMs: 0,
        };
      },
    });
    await engine.initialize();

    const githubBodyBase64 = Buffer.from(`{"action":"opened"}`, "utf-8").toString("base64");
    const githubHeaders = { "x-hub-signature-256": "sha256=abc", "x-github-event": "pull_request" };

    await engine.signal(
      {
        type: "gh-pr-comment",
        data: { action: "opened" },
        body: githubBodyBase64,
        headers: githubHeaders,
      },
      { sessionId: "s1", workspaceId: "w1" },
    );

    // Both actions should have captured body + headers in ctx.input.
    expect(captured).toHaveLength(2);
    const verifyInput = captured.find((c) => c.stateId === "verify")?.input;
    const processInput = captured.find((c) => c.stateId === "process")?.input;
    expect(verifyInput?.body, "first action (no inputFrom) sees body").toBe(githubBodyBase64);
    expect(verifyInput?.headers, "first action sees headers").toEqual(githubHeaders);
    expect(
      processInput?.body,
      "second action with inputFrom still sees body (was dropped before fix)",
    ).toBe(githubBodyBase64);
    expect(processInput?.headers, "second action with inputFrom still sees headers").toEqual(
      githubHeaders,
    );
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
