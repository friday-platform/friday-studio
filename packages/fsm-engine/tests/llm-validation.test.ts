import type { AgentResult, ToolCall, ToolResult } from "@atlas/agent-sdk";
import { describe, expect, it } from "vitest";
import { InMemoryDocumentStore } from "../../document-store/node.ts";
import { FSMDocumentDataSchema } from "../document-schemas.ts";
import { buildLLMActionTrace, FSMEngine } from "../fsm-engine.ts";
import type { FSMDefinition, FSMLLMOutput, LLMActionTrace, OutputValidator } from "../types.ts";

/**
 * Part 1: Pure Function Tests for buildLLMActionTrace
 *
 * Tests the transformation from AgentResult → LLMActionTrace.
 * All sync, no mocks needed.
 */
describe("buildLLMActionTrace", () => {
  it("extracts content, model, and prompt fields", () => {
    const result: AgentResult<string, FSMLLMOutput> = {
      agentId: "test",
      timestamp: new Date().toISOString(),
      input: "What is 2+2?",
      ok: true,
      data: { response: "Hello world" },
      durationMs: 0,
    };
    const trace = buildLLMActionTrace(result, "gpt-4", "What is 2+2?");

    expect(trace.content).toEqual("Hello world");
    expect(trace.model).toEqual("gpt-4");
    expect(trace.prompt).toEqual("What is 2+2?");
  });

  it("passes through toolCalls and toolResults arrays (AI SDK format)", () => {
    const toolCalls: ToolCall[] = [
      { type: "tool-call", toolCallId: "tc1", toolName: "search", input: { query: "test" } },
      {
        type: "tool-call",
        toolCallId: "tc2",
        toolName: "fetch",
        input: { url: "http://example.com" },
      },
    ];
    const toolResults: ToolResult[] = [
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
    ];
    const result: AgentResult<string, FSMLLMOutput> = {
      agentId: "test",
      timestamp: new Date().toISOString(),
      input: "Do research",
      ok: true,
      data: { response: "Result from tools" },
      toolCalls,
      toolResults,
      durationMs: 0,
    };

    const trace = buildLLMActionTrace(result, "claude-3", "Do research");

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

  it("returns undefined toolCalls/toolResults when not present", () => {
    const result: AgentResult<string, FSMLLMOutput> = {
      agentId: "test",
      timestamp: new Date().toISOString(),
      input: "Simple question",
      ok: true,
      data: { response: "No tools" },
      durationMs: 0,
    };
    const trace = buildLLMActionTrace(result, "gpt-4", "Simple question");

    expect(trace.toolCalls).toEqual(undefined);
    expect(trace.toolResults).toEqual(undefined);
  });

  it("returns empty arrays when result has empty arrays (not undefined)", () => {
    const result: AgentResult<string, FSMLLMOutput> = {
      agentId: "test",
      timestamp: new Date().toISOString(),
      input: "No tools needed",
      ok: true,
      data: { response: "Empty tools" },
      toolCalls: [],
      toolResults: [],
      durationMs: 0,
    };
    const trace = buildLLMActionTrace(result, "gpt-4", "No tools needed");

    expect(trace.toolCalls).toEqual([]);
    expect(trace.toolResults).toEqual([]);
  });

  it("passes through toolResults with AI SDK format", () => {
    const result: AgentResult<string, FSMLLMOutput> = {
      agentId: "test",
      timestamp: new Date().toISOString(),
      input: "Calculate",
      ok: true,
      data: { response: "Mapped result" },
      toolResults: [
        {
          type: "tool-result",
          toolCallId: "call-xyz-123",
          toolName: "calculator",
          input: {},
          output: 42,
        },
      ],
      durationMs: 0,
    };
    const trace = buildLLMActionTrace(result, "claude-3", "Calculate");

    expect(trace.toolResults?.[0]?.toolCallId).toEqual("call-xyz-123");
    expect(trace.toolResults?.[0]?.toolName).toEqual("calculator");
    expect(trace.toolResults?.[0]?.output).toEqual(42);
  });

  it("extracts error reason for failed results", () => {
    const result: AgentResult<string, FSMLLMOutput> = {
      agentId: "test",
      timestamp: new Date().toISOString(),
      input: "Do something",
      ok: false,
      error: { reason: "API rate limit exceeded" },
      durationMs: 0,
    };
    const trace = buildLLMActionTrace(result, "gpt-4", "Do something");

    expect(trace.content).toEqual("API rate limit exceeded");
    expect(trace.toolCalls).toEqual(undefined);
    expect(trace.toolResults).toEqual(undefined);
  });
});

/**
 * Mock LLM response format for tests.
 * Simplified format that gets converted to AgentResult.
 */
interface MockLLMResponse {
  content: string;
  data?: Record<string, unknown>;
  calledTool?: { name: string; args: unknown };
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
}

/**
 * Convert mock LLM response to AgentResult envelope.
 */
function mockToEnvelope(
  mock: MockLLMResponse,
  agentId: string,
  prompt: string,
): AgentResult<string, FSMLLMOutput> {
  // Build tool calls: use explicit arrays if provided, otherwise build from calledTool
  const toolCalls: ToolCall[] = mock.toolCalls ?? [];
  if (!mock.toolCalls && mock.calledTool) {
    toolCalls.push({
      type: "tool-call",
      toolCallId: `mock-${mock.calledTool.name}`,
      toolName: mock.calledTool.name,
      input: mock.calledTool.args,
    });
  }

  // Build data - use response field for text content
  const data: FSMLLMOutput = { response: mock.content, ...mock.data };

  return {
    agentId,
    timestamp: new Date().toISOString(),
    input: prompt,
    ok: true,
    data,
    toolCalls,
    toolResults: mock.toolResults,
    durationMs: 0,
  };
}

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
    llmResponses: MockLLMResponse[];
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
      call: (params) => {
        const mockResponse =
          opts.llmResponses[callCount] ?? opts.llmResponses[opts.llmResponses.length - 1];
        callCount++;
        if (!mockResponse) {
          throw new Error("No LLM response available for mock");
        }
        return Promise.resolve(mockToEnvelope(mockResponse, params.agentId, params.prompt));
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

  it("validation pass → document persisted with response, state is done", async () => {
    const { engine, store, scope, fsm } = await createLLMEngine({
      validator: () => Promise.resolve({ valid: true }),
      llmResponses: [{ content: "validated response", data: { extra: "info" } }],
    });

    await engine.signal({ type: "RUN_LLM" });

    // Observable outcome: state transitioned
    expect(engine.state).toEqual("done");

    // Observable outcome: document persisted with LLM response
    const docResult = await store.read(scope, fsm.id, "output", FSMDocumentDataSchema);
    expect(docResult.ok).toBe(true);
    if (!docResult.ok) throw new Error(docResult.error);
    expect(docResult.data?.data.data.response).toEqual("validated response");
    expect(docResult.data?.data.data.extra).toEqual("info");
  });

  it("retry success → final output persisted with retry response", async () => {
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

    // Observable outcome: document has retry response (not original bad response)
    const docResult = await store.read(scope, fsm.id, "output", FSMDocumentDataSchema);
    expect(docResult.ok).toBe(true);
    if (!docResult.ok) throw new Error(docResult.error);
    expect(docResult.data?.data.data.response).toEqual("good retry response");
    expect(docResult.data?.data.data.retried).toEqual(true);
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
    expect(error?.message).toContain("failed validation after retry");
    expect(error?.message).toContain("Still wrong");

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
    const docResult = await store.read(scope, fsm.id, "output", FSMDocumentDataSchema);
    expect(docResult.ok).toBe(true);
    if (!docResult.ok) throw new Error(docResult.error);
    expect(docResult.data?.data.data.response).toEqual("direct response");

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

  it("empty response string → document persisted with empty string", async () => {
    const { engine, store, scope, fsm } = await createLLMEngine({
      validator: () => Promise.resolve({ valid: true }),
      llmResponses: [{ content: "", data: { hasTools: false } }],
    });

    await engine.signal({ type: "RUN_LLM" });

    // Observable outcome: state transitioned
    expect(engine.state).toEqual("done");

    // Observable outcome: empty string persisted (not undefined/null)
    const docResult = await store.read(scope, fsm.id, "output", FSMDocumentDataSchema);
    expect(docResult.ok).toBe(true);
    if (!docResult.ok) throw new Error(docResult.error);
    expect(docResult.data?.data.data.response).toEqual("");
    expect(docResult.data?.data.data.hasTools).toEqual(false);
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
    expect(error?.message).toContain("LLM step failed on retry");
    expect(error?.message).toContain("Cannot comply with validation");

    // Observable outcome: state unchanged (transaction rolled back)
    expect(engine.state).toEqual("pending");
  });

  it("retry merges original tool results when retry LLM does not re-issue calls", async () => {
    const originalToolCalls: ToolCall[] = [
      { type: "tool-call", toolCallId: "tc1", toolName: "search", input: { q: "test" } },
    ];
    const originalToolResults: ToolResult[] = [
      {
        type: "tool-result",
        toolCallId: "tc1",
        toolName: "search",
        input: { q: "test" },
        output: { hits: 42 },
      },
    ];

    // Capture the trace passed to the validator on each call
    const validatorTraces: LLMActionTrace[] = [];
    const validator: OutputValidator = (trace) => {
      validatorTraces.push(trace);
      // Fail first, pass second
      if (validatorTraces.length === 1) {
        return Promise.resolve({ valid: false, feedback: "Looks hallucinated" });
      }
      return Promise.resolve({ valid: true });
    };

    const { engine } = await createLLMEngine({
      validator,
      llmResponses: [
        // First call: has tool results
        {
          content: "original with tools",
          toolCalls: originalToolCalls,
          toolResults: originalToolResults,
        },
        // Retry: no tool calls or results (LLM didn't re-issue)
        { content: "retry without tools" },
      ],
    });

    await engine.signal({ type: "RUN_LLM" });

    // Validator called twice (initial + retry)
    expect(validatorTraces.length).toEqual(2);

    // Retry trace should contain the ORIGINAL tool results (merged)
    const retryTrace = validatorTraces[1];
    expect(retryTrace?.toolResults?.length).toEqual(1);
    expect(retryTrace?.toolResults?.[0]?.toolName).toEqual("search");
    expect(retryTrace?.toolResults?.[0]?.output).toEqual({ hits: 42 });
    expect(retryTrace?.toolCalls?.length).toEqual(1);
    expect(retryTrace?.toolCalls?.[0]?.toolName).toEqual("search");
  });

  it("retry keeps its own tool results when it re-issues calls", async () => {
    const originalToolResults: ToolResult[] = [
      {
        type: "tool-result",
        toolCallId: "tc1",
        toolName: "search",
        input: { q: "test" },
        output: { hits: 42 },
      },
    ];
    const retryToolCalls: ToolCall[] = [
      { type: "tool-call", toolCallId: "tc2", toolName: "lookup", input: { id: 1 } },
    ];
    const retryToolResults: ToolResult[] = [
      {
        type: "tool-result",
        toolCallId: "tc2",
        toolName: "lookup",
        input: { id: 1 },
        output: { name: "fresh data" },
      },
    ];

    const validatorTraces: LLMActionTrace[] = [];
    const validator: OutputValidator = (trace) => {
      validatorTraces.push(trace);
      if (validatorTraces.length === 1) {
        return Promise.resolve({ valid: false, feedback: "Hallucinated" });
      }
      return Promise.resolve({ valid: true });
    };

    const { engine } = await createLLMEngine({
      validator,
      llmResponses: [
        // First call: has tool results
        {
          content: "original",
          toolCalls: [
            { type: "tool-call", toolCallId: "tc1", toolName: "search", input: { q: "test" } },
          ],
          toolResults: originalToolResults,
        },
        // Retry: has its OWN tool results
        {
          content: "retry with own tools",
          toolCalls: retryToolCalls,
          toolResults: retryToolResults,
        },
      ],
    });

    await engine.signal({ type: "RUN_LLM" });

    expect(validatorTraces.length).toEqual(2);

    // Retry trace should keep its OWN tool results (NOT merged)
    const retryTrace = validatorTraces[1];
    expect(retryTrace?.toolResults?.length).toEqual(1);
    expect(retryTrace?.toolResults?.[0]?.toolName).toEqual("lookup");
    expect(retryTrace?.toolResults?.[0]?.output).toEqual({ name: "fresh data" });
    expect(retryTrace?.toolCalls?.[0]?.toolName).toEqual("lookup");
  });
});
