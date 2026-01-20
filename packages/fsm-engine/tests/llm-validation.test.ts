import { describe, expect, it } from "vitest";
import { InMemoryDocumentStore } from "../../document-store/node.ts";
import { FSMDocumentDataSchema } from "../document-schemas.ts";
import { buildLLMActionTrace, FSMEngine } from "../fsm-engine.ts";
import type { FSMDefinition, LLMResponse, OutputValidator } from "../types.ts";

/**
 * Part 1: Pure Function Tests for buildLLMActionTrace
 *
 * Tests the transformation from LLMResponse → LLMActionTrace.
 * All sync, no mocks needed.
 */
describe("buildLLMActionTrace", () => {
  it("extracts content, model, and prompt fields", () => {
    const response: LLMResponse = { content: "Hello world" };
    const trace = buildLLMActionTrace(response, "gpt-4", "What is 2+2?");

    expect(trace.content).toEqual("Hello world");
    expect(trace.model).toEqual("gpt-4");
    expect(trace.prompt).toEqual("What is 2+2?");
  });

  it("passes through toolCalls and toolResults arrays from data (AI SDK format)", () => {
    const response: LLMResponse = {
      content: "Result from tools",
      data: {
        toolCalls: [
          { type: "tool-call", toolCallId: "tc1", toolName: "search", input: { query: "test" } },
          {
            type: "tool-call",
            toolCallId: "tc2",
            toolName: "fetch",
            input: { url: "http://example.com" },
          },
        ],
        toolResults: [
          {
            type: "tool-result",
            toolCallId: "tc1",
            toolName: "search",
            input: {},
            output: { results: ["a", "b"] },
          },
          {
            type: "tool-result",
            toolCallId: "tc2",
            toolName: "fetch",
            input: {},
            output: { body: "<html>" },
          },
        ],
      },
    };

    const trace = buildLLMActionTrace(response, "claude-3", "Do research");

    expect(trace.toolCalls?.length).toEqual(2);
    expect(trace.toolCalls?.[0]?.toolCallId).toEqual("tc1");
    expect(trace.toolCalls?.[0]?.toolName).toEqual("search");
    expect(trace.toolCalls?.[0]?.input).toEqual({ query: "test" });
    expect(trace.toolCalls?.[1]?.toolCallId).toEqual("tc2");
    expect(trace.toolCalls?.[1]?.toolName).toEqual("fetch");

    expect(trace.toolResults?.length).toEqual(2);
    expect(trace.toolResults?.[0]?.toolCallId).toEqual("tc1");
    expect(trace.toolResults?.[0]?.toolName).toEqual("search");
    expect(trace.toolResults?.[0]?.output).toEqual({ results: ["a", "b"] });
    expect(trace.toolResults?.[1]?.toolCallId).toEqual("tc2");
    expect(trace.toolResults?.[1]?.toolName).toEqual("fetch");
    expect(trace.toolResults?.[1]?.output).toEqual({ body: "<html>" });
  });

  it("returns undefined toolCalls/toolResults for empty data object", () => {
    const response: LLMResponse = { content: "No tools", data: {} };
    const trace = buildLLMActionTrace(response, "gpt-4", "Simple question");

    expect(trace.toolCalls).toEqual(undefined);
    expect(trace.toolResults).toEqual(undefined);
  });

  it("returns empty arrays when data has empty arrays (not undefined)", () => {
    const response: LLMResponse = {
      content: "Empty tools",
      data: { toolCalls: [], toolResults: [] },
    };
    const trace = buildLLMActionTrace(response, "gpt-4", "No tools needed");

    expect(trace.toolCalls).toEqual([]);
    expect(trace.toolResults).toEqual([]);
  });

  it("passes through toolResults with AI SDK format", () => {
    const response: LLMResponse = {
      content: "Mapped result",
      data: {
        toolResults: [
          {
            type: "tool-result",
            toolCallId: "call-xyz-123",
            toolName: "calculator",
            input: {},
            output: 42,
          },
        ],
      },
    };
    const trace = buildLLMActionTrace(response, "claude-3", "Calculate");

    expect(trace.toolResults?.[0]?.toolCallId).toEqual("call-xyz-123");
    expect(trace.toolResults?.[0]?.toolName).toEqual("calculator");
    expect(trace.toolResults?.[0]?.output).toEqual(42);
  });
});

/**
 * Part 2: Behavior Tests for Validation Hook
 *
 * Tests observable outcomes of the validation flow in executeAction.
 * Verifies document persistence, state transitions, and error propagation.
 */
describe("LLM Action Validation Hook", () => {
  /** Helper: Create FSM engine with LLM action and optional validator */
  async function createLLMEngine(opts: {
    validator?: OutputValidator;
    llmResponses: LLMResponse[];
  }) {
    const store = new InMemoryDocumentStore();
    const scope = { workspaceId: "test", sessionId: "test-session" };

    const fsm: FSMDefinition = {
      id: "llm-validation-test",
      initial: "pending",
      states: {
        pending: {
          on: {
            RUN_LLM: {
              target: "done",
              actions: [
                {
                  type: "llm",
                  provider: "test",
                  model: "test-model",
                  prompt: "Do something",
                  outputTo: "output",
                },
              ],
            },
          },
        },
        done: { type: "final" },
      },
    };

    let callCount = 0;
    const mockLLMProvider: import("../types.ts").LLMProvider = {
      call: (_params) => {
        const response =
          opts.llmResponses[callCount] ?? opts.llmResponses[opts.llmResponses.length - 1];
        callCount++;
        if (!response) {
          throw new Error("No LLM response available for mock");
        }
        return Promise.resolve(response);
      },
    };

    const engine = new FSMEngine(fsm, {
      documentStore: store,
      scope,
      llmProvider: mockLLMProvider,
      validateOutput: opts.validator,
    });
    await engine.initialize();

    return { engine, store, scope, fsm, getLLMCallCount: () => callCount };
  }

  it("validation pass → document persisted with content, state is done", async () => {
    const { engine, store, scope, fsm } = await createLLMEngine({
      validator: () => Promise.resolve({ valid: true }),
      llmResponses: [{ content: "validated response", data: { extra: "info" } }],
    });

    await engine.signal({ type: "RUN_LLM" });

    // Observable outcome: state transitioned
    expect(engine.state).toEqual("done");

    // Observable outcome: document persisted with LLM content
    const doc = await store.read(scope, fsm.id, "output", FSMDocumentDataSchema);
    expect(doc?.data.data.content).toEqual("validated response");
    expect(doc?.data.data.extra).toEqual("info");
  });

  it("retry success → final output persisted with retry content", async () => {
    const { engine, store, scope, fsm } = await createLLMEngine({
      validator: (trace) => {
        // Fail first attempt, pass retry
        if (trace.content === "bad response") {
          return Promise.resolve({ valid: false, feedback: "That was wrong" });
        }
        return Promise.resolve({ valid: true });
      },
      llmResponses: [
        { content: "bad response" },
        { content: "good retry response", data: { retried: true } },
      ],
    });

    await engine.signal({ type: "RUN_LLM" });

    // Observable outcome: state transitioned after retry
    expect(engine.state).toEqual("done");

    // Observable outcome: document has retry content (not original bad content)
    const doc = await store.read(scope, fsm.id, "output", FSMDocumentDataSchema);
    expect(doc?.data.data.content).toEqual("good retry response");
    expect(doc?.data.data.retried).toEqual(true);
  });

  it("double failure → throws, state unchanged at pending", async () => {
    const { engine } = await createLLMEngine({
      validator: () => Promise.resolve({ valid: false, feedback: "Still wrong" }),
      llmResponses: [{ content: "first bad" }, { content: "second bad" }],
    });

    // Observable outcome: throws error with validation feedback
    let error: Error | undefined;
    try {
      await engine.signal({ type: "RUN_LLM" });
    } catch (e) {
      error = e as Error;
    }
    expect(error).toBeInstanceOf(Error);
    expect(error!.message).toContain("failed validation after retry");
    expect(error!.message).toContain("Still wrong");

    // Observable outcome: state unchanged (transaction rolled back)
    expect(engine.state).toEqual("pending");
  });

  it("no validator → document persisted without retry", async () => {
    const { engine, store, scope, fsm, getLLMCallCount } = await createLLMEngine({
      validator: undefined, // No validator
      llmResponses: [{ content: "direct response" }],
    });

    await engine.signal({ type: "RUN_LLM" });

    // Observable outcome: state transitioned
    expect(engine.state).toEqual("done");

    // Observable outcome: document persisted
    const doc = await store.read(scope, fsm.id, "output", FSMDocumentDataSchema);
    expect(doc?.data.data.content).toEqual("direct response");

    // LLM called exactly once (no retry without validator)
    expect(getLLMCallCount()).toEqual(1);
  });

  it("validator throws → error propagates (fail-closed behavior)", async () => {
    const { engine } = await createLLMEngine({
      validator: () => Promise.reject(new Error("Validator crashed")),
      llmResponses: [{ content: "some response" }],
    });

    // Observable outcome: validator error propagates
    await expect(async () => await engine.signal({ type: "RUN_LLM" })).rejects.toThrow(
      /Validator crashed/,
    );

    // Observable outcome: state unchanged (fail-closed)
    expect(engine.state).toEqual("pending");
  });

  it("empty content string → document persisted with empty string", async () => {
    const { engine, store, scope, fsm } = await createLLMEngine({
      validator: () => Promise.resolve({ valid: true }),
      llmResponses: [{ content: "", data: { hasTools: false } }],
    });

    await engine.signal({ type: "RUN_LLM" });

    // Observable outcome: state transitioned
    expect(engine.state).toEqual("done");

    // Observable outcome: empty string persisted (not undefined/null)
    const doc = await store.read(scope, fsm.id, "output", FSMDocumentDataSchema);
    expect(doc?.data.data.content).toEqual("");
    expect(doc?.data.data.hasTools).toEqual(false);
  });

  it("failStep on retry → throws error, state unchanged", async () => {
    const { engine } = await createLLMEngine({
      validator: (trace) => {
        // Fail first attempt to trigger retry
        if (trace.content === "first attempt") {
          return Promise.resolve({ valid: false, feedback: "Try again" });
        }
        // Should never reach here - failStep should be caught first
        return Promise.resolve({ valid: true });
      },
      llmResponses: [
        { content: "first attempt" },
        {
          content: "",
          calledTool: { name: "failStep", args: { reason: "Cannot comply with validation" } },
        },
      ],
    });

    // Observable outcome: throws error containing failStep info
    let error: Error | undefined;
    try {
      await engine.signal({ type: "RUN_LLM" });
    } catch (e) {
      error = e as Error;
    }
    expect(error).toBeInstanceOf(Error);
    expect(error!.message).toContain("LLM step failed on retry");
    expect(error!.message).toContain("Cannot comply with validation");

    // Observable outcome: state unchanged (transaction rolled back)
    expect(engine.state).toEqual("pending");
  });
});
