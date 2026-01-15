import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
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

    assertEquals(trace.content, "Hello world");
    assertEquals(trace.model, "gpt-4");
    assertEquals(trace.prompt, "What is 2+2?");
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

    assertEquals(trace.toolCalls?.length, 2);
    assertEquals(trace.toolCalls?.[0]?.toolCallId, "tc1");
    assertEquals(trace.toolCalls?.[0]?.toolName, "search");
    assertEquals(trace.toolCalls?.[0]?.input, { query: "test" });
    assertEquals(trace.toolCalls?.[1]?.toolCallId, "tc2");
    assertEquals(trace.toolCalls?.[1]?.toolName, "fetch");

    assertEquals(trace.toolResults?.length, 2);
    assertEquals(trace.toolResults?.[0]?.toolCallId, "tc1");
    assertEquals(trace.toolResults?.[0]?.toolName, "search");
    assertEquals(trace.toolResults?.[0]?.output, { results: ["a", "b"] });
    assertEquals(trace.toolResults?.[1]?.toolCallId, "tc2");
    assertEquals(trace.toolResults?.[1]?.toolName, "fetch");
    assertEquals(trace.toolResults?.[1]?.output, { body: "<html>" });
  });

  it("returns undefined toolCalls/toolResults for empty data object", () => {
    const response: LLMResponse = { content: "No tools", data: {} };
    const trace = buildLLMActionTrace(response, "gpt-4", "Simple question");

    assertEquals(trace.toolCalls, undefined);
    assertEquals(trace.toolResults, undefined);
  });

  it("returns empty arrays when data has empty arrays (not undefined)", () => {
    const response: LLMResponse = {
      content: "Empty tools",
      data: { toolCalls: [], toolResults: [] },
    };
    const trace = buildLLMActionTrace(response, "gpt-4", "No tools needed");

    assertEquals(trace.toolCalls, []);
    assertEquals(trace.toolResults, []);
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

    assertEquals(trace.toolResults?.[0]?.toolCallId, "call-xyz-123");
    assertEquals(trace.toolResults?.[0]?.toolName, "calculator");
    assertEquals(trace.toolResults?.[0]?.output, 42);
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
    assertEquals(engine.state, "done");

    // Observable outcome: document persisted with LLM content
    const doc = await store.read(scope, fsm.id, "output", FSMDocumentDataSchema);
    assertEquals(doc?.data.data.content, "validated response");
    assertEquals(doc?.data.data.extra, "info");
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
    assertEquals(engine.state, "done");

    // Observable outcome: document has retry content (not original bad content)
    const doc = await store.read(scope, fsm.id, "output", FSMDocumentDataSchema);
    assertEquals(doc?.data.data.content, "good retry response");
    assertEquals(doc?.data.data.retried, true);
  });

  it("double failure → throws, state unchanged at pending", async () => {
    const { engine } = await createLLMEngine({
      validator: () => Promise.resolve({ valid: false, feedback: "Still wrong" }),
      llmResponses: [{ content: "first bad" }, { content: "second bad" }],
    });

    // Observable outcome: throws error
    const error = await assertRejects(async () => await engine.signal({ type: "RUN_LLM" }));
    assertStringIncludes(String(error), "failed validation after retry");
    assertStringIncludes(String(error), "Still wrong");

    // Observable outcome: state unchanged (transaction rolled back)
    assertEquals(engine.state, "pending");
  });

  it("no validator → document persisted without retry", async () => {
    const { engine, store, scope, fsm, getLLMCallCount } = await createLLMEngine({
      validator: undefined, // No validator
      llmResponses: [{ content: "direct response" }],
    });

    await engine.signal({ type: "RUN_LLM" });

    // Observable outcome: state transitioned
    assertEquals(engine.state, "done");

    // Observable outcome: document persisted
    const doc = await store.read(scope, fsm.id, "output", FSMDocumentDataSchema);
    assertEquals(doc?.data.data.content, "direct response");

    // LLM called exactly once (no retry without validator)
    assertEquals(getLLMCallCount(), 1);
  });

  it("validator throws → error propagates (fail-closed behavior)", async () => {
    const { engine } = await createLLMEngine({
      validator: () => Promise.reject(new Error("Validator crashed")),
      llmResponses: [{ content: "some response" }],
    });

    // Observable outcome: validator error propagates
    const error = await assertRejects(async () => await engine.signal({ type: "RUN_LLM" }));
    assertStringIncludes(String(error), "Validator crashed");

    // Observable outcome: state unchanged (fail-closed)
    assertEquals(engine.state, "pending");
  });

  it("empty content string → document persisted with empty string", async () => {
    const { engine, store, scope, fsm } = await createLLMEngine({
      validator: () => Promise.resolve({ valid: true }),
      llmResponses: [{ content: "", data: { hasTools: false } }],
    });

    await engine.signal({ type: "RUN_LLM" });

    // Observable outcome: state transitioned
    assertEquals(engine.state, "done");

    // Observable outcome: empty string persisted (not undefined/null)
    const doc = await store.read(scope, fsm.id, "output", FSMDocumentDataSchema);
    assertEquals(doc?.data.data.content, "");
    assertEquals(doc?.data.data.hasTools, false);
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
    const error = await assertRejects(async () => await engine.signal({ type: "RUN_LLM" }));
    assertStringIncludes(String(error), "LLM step failed on retry");
    assertStringIncludes(String(error), "Cannot comply with validation");

    // Observable outcome: state unchanged (transaction rolled back)
    assertEquals(engine.state, "pending");
  });
});
