import { describe, expect, it } from "vitest";
import { FSMEngine } from "../fsm-engine.ts";
import type { AgentAction, Context, FSMDefinition } from "../types.ts";
import { createTestEngine } from "./lib/test-utils.ts";

describe("FSM Engine - Results Accumulator", () => {
  describe("engine.results getter", () => {
    it("returns empty object initially", async () => {
      const fsm: FSMDefinition = { id: "results-empty", initial: "idle", states: { idle: {} } };

      const { engine } = await createTestEngine(fsm);
      expect(engine.results).toEqual({});
    });
  });

  describe("context.results in code actions", () => {
    it("is available to code actions", async () => {
      const fsm: FSMDefinition = {
        id: "context-results",
        initial: "idle",
        states: {
          idle: {
            on: { GO: { target: "done", actions: [{ type: "code", function: "assert_results" }] } },
          },
          done: { type: "final" },
        },
        functions: {
          assert_results: {
            type: "action",
            code: `export default function assert_results(context) {
              if (typeof context.results !== "object" || context.results === null) {
                throw new Error("context.results is not an object: " + typeof context.results);
              }
            }`,
          },
        },
      };

      const { engine } = await createTestEngine(fsm);
      await engine.signal({ type: "GO" });
      expect(engine.state).toEqual("done");
    });
  });

  describe("results clear on transition to initial state", () => {
    it("clears results when transitioning back to initial state", async () => {
      const fsm: FSMDefinition = {
        id: "results-clear-initial",
        initial: "idle",
        states: {
          idle: { on: { START: { target: "working" } } },
          working: {
            entry: [{ type: "code", function: "write_result" }],
            on: { DONE: { target: "idle" } },
          },
        },
        functions: {
          write_result: {
            type: "action",
            code: `export default function write_result(context) {
              context.setResult("analysis", { summary: "found stuff" });
            }`,
          },
        },
      };

      const { engine } = await createTestEngine(fsm);

      // Transition to working - write a result
      await engine.signal({ type: "START" });
      expect(engine.state).toEqual("working");
      expect(engine.results).toEqual({ analysis: { summary: "found stuff" } });

      // Transition back to idle - results should clear
      await engine.signal({ type: "DONE" });
      expect(engine.state).toEqual("idle");
      expect(engine.results).toEqual({});
    });
  });

  describe("results clear on reset()", () => {
    it("clears results when reset is called", async () => {
      const fsm: FSMDefinition = {
        id: "results-clear-reset",
        initial: "idle",
        states: {
          idle: { on: { START: { target: "working" } } },
          working: { entry: [{ type: "code", function: "write_result" }] },
        },
        functions: {
          write_result: {
            type: "action",
            code: `export default function write_result(context) {
              context.setResult("report", { title: "test report" });
            }`,
          },
        },
      };

      const { engine } = await createTestEngine(fsm);

      await engine.signal({ type: "START" });
      expect(engine.results).toEqual({ report: { title: "test report" } });

      await engine.reset();
      expect(engine.state).toEqual("idle");
      expect(engine.results).toEqual({});
    });
  });

  describe("context.results reflects pending state inside transaction", () => {
    it("second code action sees results written by first in same action sequence", async () => {
      const fsm: FSMDefinition = {
        id: "results-pending",
        initial: "idle",
        states: {
          idle: {
            on: {
              GO: {
                target: "done",
                actions: [
                  { type: "code", function: "write_result" },
                  { type: "code", function: "read_result" },
                ],
              },
            },
          },
          done: { type: "final" },
        },
        functions: {
          write_result: {
            type: "action",
            code: `export default function write_result(context) {
              context.setResult("step1", { value: 42 });
            }`,
          },
          read_result: {
            type: "action",
            code: `export default function read_result(context) {
              const step1 = context.results.step1;
              if (!step1 || step1.value !== 42) {
                throw new Error("Expected step1.value to be 42, got: " + JSON.stringify(step1));
              }
            }`,
          },
        },
      };

      const { engine } = await createTestEngine(fsm);
      await engine.signal({ type: "GO" });
      expect(engine.state).toEqual("done");
      expect(engine.results).toEqual({ step1: { value: 42 } });
    });
  });

  describe("agent output dual-write to results and documents", () => {
    it("agent output with outputTo writes to engine.results and engine.documents", async () => {
      const fsm: FSMDefinition = {
        id: "agent-dual-write",
        initial: "idle",
        states: {
          idle: {
            on: {
              START: {
                target: "done",
                actions: [{ type: "agent", agentId: "analyzer", outputTo: "analysis" }],
              },
            },
          },
          done: { type: "final" },
        },
      };

      const { store, scope } = await createTestEngine(fsm, { initialState: "idle" });

      const engine = new FSMEngine(fsm, {
        documentStore: store,
        scope,
        agentExecutor: (action: AgentAction, _ctx: Context) =>
          Promise.resolve({
            agentId: action.agentId,
            timestamp: new Date().toISOString(),
            input: "",
            ok: true as const,
            data: { summary: "test summary", rowCount: 42 },
            durationMs: 0,
          }),
      });
      await engine.initialize();

      await engine.signal({ type: "START" });

      // Results accumulator has the data
      expect(engine.results).toEqual({ analysis: { summary: "test summary", rowCount: 42 } });
      // Documents also have the data (dual-write)
      expect(engine.documents.find((d) => d.id === "analysis")).toBeDefined();
    });

    it("schema validation: valid output passes when outputType declared", async () => {
      const fsm: FSMDefinition = {
        id: "agent-schema-valid",
        initial: "idle",
        documentTypes: {
          AnalysisResult: {
            type: "object",
            properties: { summary: { type: "string" }, rowCount: { type: "number" } },
            required: ["summary", "rowCount"],
          },
        },
        states: {
          idle: {
            on: {
              START: {
                target: "done",
                actions: [
                  {
                    type: "agent",
                    agentId: "analyzer",
                    outputTo: "analysis",
                    outputType: "AnalysisResult",
                  },
                ],
              },
            },
          },
          done: { type: "final" },
        },
      };

      const { store, scope } = await createTestEngine(fsm, { initialState: "idle" });

      const engine = new FSMEngine(fsm, {
        documentStore: store,
        scope,
        agentExecutor: (action: AgentAction, _ctx: Context) =>
          Promise.resolve({
            agentId: action.agentId,
            timestamp: new Date().toISOString(),
            input: "",
            ok: true as const,
            data: { summary: "looks good", rowCount: 10 },
            durationMs: 0,
          }),
      });
      await engine.initialize();

      await engine.signal({ type: "START" });

      expect(engine.state).toEqual("done");
      expect(engine.results).toEqual({ analysis: { summary: "looks good", rowCount: 10 } });
    });

    it("schema validation: invalid output fails with clear error", async () => {
      const fsm: FSMDefinition = {
        id: "agent-schema-invalid",
        initial: "idle",
        documentTypes: {
          AnalysisResult: {
            type: "object",
            properties: { summary: { type: "string" }, rowCount: { type: "number" } },
            required: ["summary", "rowCount"],
          },
        },
        states: {
          idle: {
            on: {
              START: {
                target: "done",
                actions: [
                  {
                    type: "agent",
                    agentId: "data-analyst",
                    outputTo: "analysis",
                    outputType: "AnalysisResult",
                  },
                ],
              },
            },
          },
          done: { type: "final" },
        },
      };

      const { store, scope } = await createTestEngine(fsm, { initialState: "idle" });

      const engine = new FSMEngine(fsm, {
        documentStore: store,
        scope,
        agentExecutor: (action: AgentAction, _ctx: Context) =>
          Promise.resolve({
            agentId: action.agentId,
            timestamp: new Date().toISOString(),
            input: "",
            ok: true as const,
            data: { wrong_field: "oops" },
            durationMs: 0,
          }),
      });
      await engine.initialize();

      await expect(engine.signal({ type: "START" })).rejects.toThrow(
        /data-analyst.*AnalysisResult/,
      );
      // State should NOT have transitioned
      expect(engine.state).toEqual("idle");
      expect(engine.results).toEqual({});
    });

    it("no outputType: merges without validation (backward compat)", async () => {
      const fsm: FSMDefinition = {
        id: "agent-no-output-type",
        initial: "idle",
        states: {
          idle: {
            on: {
              START: {
                target: "done",
                actions: [{ type: "agent", agentId: "worker", outputTo: "result" }],
              },
            },
          },
          done: { type: "final" },
        },
      };

      const { store, scope } = await createTestEngine(fsm, { initialState: "idle" });

      const engine = new FSMEngine(fsm, {
        documentStore: store,
        scope,
        agentExecutor: (action: AgentAction, _ctx: Context) =>
          Promise.resolve({
            agentId: action.agentId,
            timestamp: new Date().toISOString(),
            input: "",
            ok: true as const,
            data: { anything: "goes", nested: { works: true } },
            durationMs: 0,
          }),
      });
      await engine.initialize();

      await engine.signal({ type: "START" });

      expect(engine.state).toEqual("done");
      expect(engine.results).toEqual({ result: { anything: "goes", nested: { works: true } } });
    });

    it("repeated write to same outputTo replaces previous value", async () => {
      const fsm: FSMDefinition = {
        id: "agent-replace",
        initial: "idle",
        states: {
          idle: {
            on: {
              START: {
                target: "done",
                actions: [
                  { type: "agent", agentId: "first", outputTo: "result" },
                  { type: "agent", agentId: "second", outputTo: "result" },
                ],
              },
            },
          },
          done: { type: "final" },
        },
      };

      let callCount = 0;
      const { store, scope } = await createTestEngine(fsm, { initialState: "idle" });

      const engine = new FSMEngine(fsm, {
        documentStore: store,
        scope,
        agentExecutor: (action: AgentAction, _ctx: Context) => {
          callCount++;
          return Promise.resolve({
            agentId: action.agentId,
            timestamp: new Date().toISOString(),
            input: "",
            ok: true as const,
            data: callCount === 1 ? { version: "first" } : { version: "second" },
            durationMs: 0,
          });
        },
      });
      await engine.initialize();

      await engine.signal({ type: "START" });

      expect(engine.results).toEqual({ result: { version: "second" } });
    });

    it("failed action mid-transaction: results unchanged", async () => {
      const fsm: FSMDefinition = {
        id: "agent-fail-rollback",
        initial: "idle",
        states: {
          idle: {
            on: {
              START: {
                target: "done",
                actions: [
                  { type: "agent", agentId: "first", outputTo: "step1" },
                  { type: "agent", agentId: "failing", outputTo: "step2" },
                ],
              },
            },
          },
          done: { type: "final" },
        },
      };

      let callCount = 0;
      const { store, scope } = await createTestEngine(fsm, { initialState: "idle" });

      const engine = new FSMEngine(fsm, {
        documentStore: store,
        scope,
        agentExecutor: (action: AgentAction, _ctx: Context) => {
          callCount++;
          if (callCount === 2) {
            return Promise.resolve({
              agentId: action.agentId,
              timestamp: new Date().toISOString(),
              input: "",
              ok: false as const,
              error: { reason: "something broke" },
              durationMs: 0,
            });
          }
          return Promise.resolve({
            agentId: action.agentId,
            timestamp: new Date().toISOString(),
            input: "",
            ok: true as const,
            data: { value: "written" },
            durationMs: 0,
          });
        },
      });
      await engine.initialize();

      await expect(engine.signal({ type: "START" })).rejects.toThrow("something broke");
      expect(engine.state).toEqual("idle");
      expect(engine.results).toEqual({});
    });

    it("artifactRefs merged into result after schema validation", async () => {
      const fsm: FSMDefinition = {
        id: "agent-artifact-refs",
        initial: "idle",
        documentTypes: {
          Summary: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
        },
        states: {
          idle: {
            on: {
              START: {
                target: "done",
                actions: [
                  { type: "agent", agentId: "writer", outputTo: "summary", outputType: "Summary" },
                ],
              },
            },
          },
          done: { type: "final" },
        },
      };

      const { store, scope } = await createTestEngine(fsm, { initialState: "idle" });

      const engine = new FSMEngine(fsm, {
        documentStore: store,
        scope,
        agentExecutor: (action: AgentAction, _ctx: Context) =>
          Promise.resolve({
            agentId: action.agentId,
            timestamp: new Date().toISOString(),
            input: "",
            ok: true as const,
            data: { text: "hello world" },
            artifactRefs: [
              { id: "art-1", type: "file", summary: "file.txt plain text attachment" },
            ],
            durationMs: 0,
          }),
      });
      await engine.initialize();

      await engine.signal({ type: "START" });

      // Schema validation should pass (artifactRefs not validated against Summary schema)
      expect(engine.state).toEqual("done");
      // Result should contain both data and artifactRefs
      expect(engine.results.summary).toMatchObject({
        text: "hello world",
        artifactRefs: [{ id: "art-1", type: "file", summary: "file.txt plain text attachment" }],
      });
    });
  });

  describe("LLM output dual-write to results", () => {
    it("LLM output with outputTo writes to engine.results", async () => {
      const fsm: FSMDefinition = {
        id: "llm-dual-write",
        initial: "idle",
        documentTypes: {
          Report: {
            type: "object",
            properties: { title: { type: "string" }, body: { type: "string" } },
            required: ["title", "body"],
          },
        },
        states: {
          idle: {
            on: {
              START: {
                target: "done",
                actions: [
                  {
                    type: "llm",
                    provider: "test",
                    model: "test-model",
                    prompt: "Write a report",
                    outputTo: "report",
                    outputType: "Report",
                  },
                ],
              },
            },
          },
          done: { type: "final" },
        },
      };

      const { store, scope } = await createTestEngine(fsm, { initialState: "idle" });

      const engine = new FSMEngine(fsm, {
        documentStore: store,
        scope,
        llmProvider: {
          call: () =>
            Promise.resolve({
              agentId: "test",
              timestamp: new Date().toISOString(),
              input: "",
              ok: true as const,
              data: { title: "My Report", body: "Contents here" },
              durationMs: 0,
            }),
        },
      });
      await engine.initialize();

      await engine.signal({ type: "START" });

      expect(engine.results).toEqual({ report: { title: "My Report", body: "Contents here" } });
      // Documents also populated (dual-write)
      expect(engine.documents.find((d) => d.id === "report")).toBeDefined();
    });
  });
});
