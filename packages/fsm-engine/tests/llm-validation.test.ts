import type { AgentResult, ToolCall, ToolResult } from "@atlas/agent-sdk";
import { ValidationFailedError, type ValidationVerdict } from "@atlas/hallucination";
import { describe, expect, it } from "vitest";
import { getDocumentStore } from "../../document-store/node.ts";
import { FSMDocumentDataSchema } from "../document-schemas.ts";
import { buildLLMActionTrace, FSMEngine, formatToolResultsForRetry } from "../fsm-engine.ts";
import type {
  FSMDefinition,
  FSMEvent,
  FSMLLMOutput,
  FSMValidationAttemptEvent,
  LLMActionTrace,
  OutputValidator,
} from "../types.ts";

/** Helper: pass verdict (high confidence, above threshold). */
function passVerdict(): ValidationVerdict {
  return { status: "pass", confidence: 0.9, threshold: 0.45, issues: [], retryGuidance: "" };
}

/** Helper: uncertain verdict (mid-band confidence). */
function uncertainVerdict(): ValidationVerdict {
  return { status: "uncertain", confidence: 0.4, threshold: 0.45, issues: [], retryGuidance: "" };
}

/** Helper: fail verdict (below floor). */
function failVerdict(retryGuidance: string): ValidationVerdict {
  return { status: "fail", confidence: 0.1, threshold: 0.45, issues: [], retryGuidance };
}

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
    const store = getDocumentStore();
    const scope = {
      workspaceId: `test-${crypto.randomUUID()}`,
      sessionId: `test-session-${crypto.randomUUID()}`,
    };

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
      validator: () => Promise.resolve({ verdict: passVerdict() }),
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
          return Promise.resolve({ verdict: failVerdict("That was wrong") });
        }
        return Promise.resolve({ verdict: passVerdict() });
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

  it("double failure → throws ValidationFailedError carrying verdict, state unchanged", async () => {
    const verdict = failVerdict("Still wrong");
    const { engine } = await createLLMEngine({
      validator: () => Promise.resolve({ verdict }),
      llmResponses: [{ content: "first bad" }, { content: "second bad" }],
    });

    // Observable outcome: throws ValidationFailedError with verdict on the error
    let error: Error | undefined;
    try {
      await engine.signal({ type: "RUN_LLM" });
    } catch (e) {
      error = e as Error;
    }
    expect(error).toBeInstanceOf(ValidationFailedError);
    // Message format owned by @atlas/hallucination's ValidationFailedError.
    expect(error?.message).toContain("Validation failed");
    expect(error?.message).toContain("Still wrong");
    // Verdict travels on the error so consumers (system error chunk, observability)
    // can render category/severity/citations without parsing strings.
    if (error instanceof ValidationFailedError) {
      expect(error.verdict.status).toEqual("fail");
      expect(error.verdict.retryGuidance).toEqual("Still wrong");
    }

    // Observable outcome: state unchanged (transaction rolled back)
    expect(engine.state).toEqual("pending");
  });

  it("uncertain verdict → proceeds identically to pass (no retry, no taint)", async () => {
    let validatorCallCount = 0;
    const { engine, store, scope, fsm, getLLMCallCount } = await createLLMEngine({
      validator: () => {
        validatorCallCount++;
        return Promise.resolve({ verdict: uncertainVerdict() });
      },
      llmResponses: [{ content: "uncertain response", data: { extra: "info" } }],
    });

    await engine.signal({ type: "RUN_LLM" });

    // Observable outcome: state transitioned (uncertain proceeds)
    expect(engine.state).toEqual("done");

    // Observable outcome: document persisted (no taint flag)
    const docResult = await store.read(scope, fsm.id, "output", FSMDocumentDataSchema);
    expect(docResult.ok).toBe(true);
    if (!docResult.ok) throw new Error(docResult.error);
    expect(docResult.data?.data.data.response).toEqual("uncertain response");

    // LLM called once (no retry on uncertain), validator called once
    expect(getLLMCallCount()).toEqual(1);
    expect(validatorCallCount).toEqual(1);
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
      validator: () => Promise.resolve({ verdict: passVerdict() }),
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
          return Promise.resolve({ verdict: failVerdict("Try again") });
        }
        // Should never reach here - failStep should be caught first
        return Promise.resolve({ verdict: passVerdict() });
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
        return Promise.resolve({ verdict: failVerdict("Looks hallucinated") });
      }
      return Promise.resolve({ verdict: passVerdict() });
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
        return Promise.resolve({ verdict: failVerdict("Hallucinated") });
      }
      return Promise.resolve({ verdict: passVerdict() });
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

  it("retry prompt includes previous tool results for LLM context", async () => {
    const originalToolResults: ToolResult[] = [
      {
        type: "tool-result",
        toolCallId: "tc1",
        toolName: "resource_read",
        input: { slug: "seen_issues" },
        output: { data: [{ id: "ISSUE-1" }, { id: "ISSUE-2" }] },
      },
      {
        type: "tool-result",
        toolCallId: "tc2",
        toolName: "search_issues",
        input: { project: "web" },
        output: { issues: [{ id: "ISSUE-1" }, { id: "ISSUE-3" }] },
      },
    ];

    // Capture prompts passed to the LLM
    const llmPrompts: string[] = [];
    const store = getDocumentStore();
    const scope = {
      workspaceId: `test-${crypto.randomUUID()}`,
      sessionId: `test-session-${crypto.randomUUID()}`,
    };

    const fsm: FSMDefinition = {
      id: "retry-prompt-test",
      initial: "pending",
      states: {
        pending: {
          on: {
            RUN: {
              target: "done",
              actions: [
                {
                  type: "llm",
                  provider: "test",
                  model: "test-model",
                  prompt: "Check for new issues",
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
        llmPrompts.push(params.prompt);
        callCount++;
        const response =
          callCount === 1
            ? {
                content: "Found ISSUE-1 and ISSUE-3 as new",
                toolCalls: [
                  {
                    type: "tool-call" as const,
                    toolCallId: "tc1",
                    toolName: "resource_read",
                    input: { slug: "seen_issues" },
                  },
                  {
                    type: "tool-call" as const,
                    toolCallId: "tc2",
                    toolName: "search_issues",
                    input: { project: "web" },
                  },
                ],
                toolResults: originalToolResults,
              }
            : { content: "Only ISSUE-3 is new" };
        return Promise.resolve(mockToEnvelope(response, params.agentId, params.prompt));
      },
    };

    const engine = new FSMEngine(fsm, {
      documentStore: store,
      scope,
      llmProvider: mockLLMProvider,
      validateOutput: (trace) => {
        if (trace.content.includes("ISSUE-1 and ISSUE-3")) {
          return Promise.resolve({ verdict: failVerdict("ISSUE-1 was already in the seen table") });
        }
        return Promise.resolve({ verdict: passVerdict() });
      },
    });
    await engine.initialize();
    await engine.signal({ type: "RUN" });

    expect(callCount).toEqual(2);
    // Retry prompt should contain previous tool results
    const retryPrompt = llmPrompts[1];
    expect(retryPrompt).toContain("<previous-attempt-tool-results>");
    expect(retryPrompt).toContain("resource_read");
    expect(retryPrompt).toContain("ISSUE-1");
    expect(retryPrompt).toContain("ISSUE-2");
    expect(retryPrompt).toContain("search_issues");
    expect(retryPrompt).toContain("<validation-feedback>");
    expect(retryPrompt).toContain("ISSUE-1 was already in the seen table");
    expect(retryPrompt).toContain("tool results above");
  });

  it("retry prompt without tool results does not reference tool results above", async () => {
    const llmPrompts: string[] = [];
    const store = getDocumentStore();
    const scope = {
      workspaceId: `test-${crypto.randomUUID()}`,
      sessionId: `test-session-${crypto.randomUUID()}`,
    };

    const fsm: FSMDefinition = {
      id: "no-tools-retry-test",
      initial: "pending",
      states: {
        pending: {
          on: {
            RUN: {
              target: "done",
              actions: [
                {
                  type: "llm",
                  provider: "test",
                  model: "test-model",
                  prompt: "Summarize",
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
        llmPrompts.push(params.prompt);
        callCount++;
        const response = callCount === 1 ? { content: "bad summary" } : { content: "good summary" };
        return Promise.resolve(mockToEnvelope(response, params.agentId, params.prompt));
      },
    };

    const engine = new FSMEngine(fsm, {
      documentStore: store,
      scope,
      llmProvider: mockLLMProvider,
      validateOutput: (trace) => {
        if (trace.content === "bad summary") {
          return Promise.resolve({ verdict: failVerdict("Too short") });
        }
        return Promise.resolve({ verdict: passVerdict() });
      },
    });
    await engine.initialize();
    await engine.signal({ type: "RUN" });

    expect(callCount).toEqual(2);
    const retryPrompt = llmPrompts[1];
    expect(retryPrompt).not.toContain("<previous-attempt-tool-results>");
    expect(retryPrompt).not.toContain("tool results above");
    expect(retryPrompt).toContain("<validation-feedback>");
    expect(retryPrompt).toContain("Too short");
    expect(retryPrompt).toContain("feedback above");
  });
});

/**
 * Part 3: Pure Function Tests for formatToolResultsForRetry
 */
describe("formatToolResultsForRetry", () => {
  it("returns empty string when no tool results", () => {
    const trace: LLMActionTrace = { content: "hello", model: "test", prompt: "test" };
    expect(formatToolResultsForRetry(trace)).toEqual("");
  });

  it("returns empty string for empty tool results array", () => {
    const trace: LLMActionTrace = {
      content: "hello",
      toolResults: [],
      model: "test",
      prompt: "test",
    };
    expect(formatToolResultsForRetry(trace)).toEqual("");
  });

  it("formats tool results with name, input, and output", () => {
    const trace: LLMActionTrace = {
      content: "result",
      toolResults: [
        {
          type: "tool-result",
          toolCallId: "tc1",
          toolName: "search",
          input: { query: "test" },
          output: { hits: 42 },
        },
      ],
      model: "test",
      prompt: "test",
    };
    const formatted = formatToolResultsForRetry(trace);
    expect(formatted).toContain("=== Tool Result 1: search");
    expect(formatted).toContain('"query":"test"'); // compact JSON in header
    expect(formatted).toContain('"hits": 42'); // pretty-printed JSON in body
  });

  it("truncates large tool outputs", () => {
    const largeOutput = "x".repeat(10000);
    const trace: LLMActionTrace = {
      content: "result",
      toolResults: [
        {
          type: "tool-result",
          toolCallId: "tc1",
          toolName: "big_tool",
          input: {},
          output: largeOutput,
        },
      ],
      model: "test",
      prompt: "test",
    };
    const formatted = formatToolResultsForRetry(trace);
    expect(formatted).toContain("…[truncated]");
    expect(formatted.length).toBeLessThan(largeOutput.length);
  });

  it("formats multiple tool results", () => {
    const trace: LLMActionTrace = {
      content: "result",
      toolResults: [
        {
          type: "tool-result",
          toolCallId: "tc1",
          toolName: "tool_a",
          input: {},
          output: "output_a",
        },
        {
          type: "tool-result",
          toolCallId: "tc2",
          toolName: "tool_b",
          input: { key: "val" },
          output: "output_b",
        },
      ],
      model: "test",
      prompt: "test",
    };
    const formatted = formatToolResultsForRetry(trace);
    expect(formatted).toContain("=== Tool Result 1: tool_a");
    expect(formatted).toContain("=== Tool Result 2: tool_b");
    expect(formatted).toContain("output_a");
    expect(formatted).toContain("output_b");
  });

  it("handles undefined output via serialization fallback", () => {
    const trace: LLMActionTrace = {
      content: "result",
      toolResults: [
        {
          type: "tool-result",
          toolCallId: "tc1",
          toolName: "broken_tool",
          input: {},
          output: undefined,
        },
      ],
      model: "test",
      prompt: "test",
    };
    const formatted = formatToolResultsForRetry(trace);
    // JSON.stringify(undefined) returns undefined, triggering the catch path
    expect(formatted).toContain("=== Tool Result 1: broken_tool");
    expect(formatted).toContain("[Failed to serialize]");
  });

  it("truncates when total size exceeds budget", () => {
    // Each result is ~5K chars, 15 results = ~75K > 50K budget
    const bigOutput = "y".repeat(5000);
    const results: ToolResult[] = Array.from({ length: 15 }, (_, i) => ({
      type: "tool-result" as const,
      toolCallId: `tc${i}`,
      toolName: `tool_${i}`,
      input: {},
      output: bigOutput,
    }));

    const trace: LLMActionTrace = {
      content: "result",
      toolResults: results,
      model: "test",
      prompt: "test",
    };
    const formatted = formatToolResultsForRetry(trace);

    // Should hit the total budget cap before all 15 results
    expect(formatted).toContain("truncated for size");
    // First result should be present
    expect(formatted).toContain("=== Tool Result 1: tool_0");
    // Should NOT contain the last result
    expect(formatted).not.toContain("=== Tool Result 15: tool_14");

    // Verify the reported remaining count is correct
    const match = formatted.match(/(\d+) more tool results truncated for size/);
    if (!match) throw new Error("Expected truncation message not found");
    const reportedRemaining = Number(match[1]);
    // Count how many results actually appear
    const includedCount = (formatted.match(/=== Tool Result \d+:/g) ?? []).length;
    expect(reportedRemaining + includedCount).toEqual(15);

    // Total output should be under 50K budget + truncation message (~80 chars)
    expect(formatted.length).toBeLessThan(50_200);
  });
});

/**
 * Part 4: Validation Lifecycle Event Emission
 *
 * Verifies that the FSM engine emits exactly one `running` event before each
 * judge call and exactly one terminal event (`passed` / `failed`) after, with
 * the verdict attached on terminal events. The retry-vs-terminal distinction
 * is encoded explicitly via `terminal: boolean` on `failed` events.
 */
describe("FSMValidationAttemptEvent emission", () => {
  /**
   * Run an LLM action with the given validator + responses, capture every
   * FSMEvent emitted via _context.onEvent, and return only the validation
   * lifecycle events.
   */
  async function runAndCollectValidationEvents(opts: {
    validator: OutputValidator;
    llmResponses: MockLLMResponse[];
    abortSignal?: AbortSignal;
    expectThrow?: boolean;
  }): Promise<FSMValidationAttemptEvent[]> {
    const store = getDocumentStore();
    const uid = crypto.randomUUID();
    const scope = { workspaceId: `ws-${uid}`, sessionId: `sess-${uid}` };

    const fsm: FSMDefinition = {
      id: "validation-events-test",
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
        if (!mockResponse) throw new Error("No LLM response available for mock");
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

    const events: FSMEvent[] = [];
    const sendSignal = () =>
      engine.signal(
        { type: "RUN_LLM" },
        {
          sessionId: scope.sessionId,
          workspaceId: scope.workspaceId,
          onEvent: (e) => events.push(e),
          abortSignal: opts.abortSignal,
        },
      );

    if (opts.expectThrow) {
      await expect(sendSignal()).rejects.toBeInstanceOf(ValidationFailedError);
    } else {
      await sendSignal();
    }

    return events.filter(
      (e): e is FSMValidationAttemptEvent => e.type === "data-fsm-validation-attempt",
    );
  }

  it("pass on first attempt → 1 running + 1 passed", async () => {
    const validationEvents = await runAndCollectValidationEvents({
      validator: () => Promise.resolve({ verdict: passVerdict() }),
      llmResponses: [{ content: "good response" }],
    });

    expect(validationEvents.length).toEqual(2);
    expect(validationEvents[0]?.data).toMatchObject({
      attempt: 1,
      status: "running",
      actionId: "output",
      jobName: "validation-events-test",
      state: "pending",
    });
    expect(validationEvents[0]?.data.sessionId).toMatch(/^sess-/);
    expect(validationEvents[0]?.data.workspaceId).toMatch(/^ws-/);
    expect(validationEvents[0]?.data.verdict).toBeUndefined();
    expect(validationEvents[0]?.data.terminal).toBeUndefined();

    expect(validationEvents[1]?.data).toMatchObject({
      attempt: 1,
      status: "passed",
      actionId: "output",
    });
    expect(validationEvents[1]?.data.verdict?.status).toEqual("pass");
    expect(validationEvents[1]?.data.terminal).toBeUndefined();
  });

  it("uncertain on first attempt → 1 running + 1 passed (uncertain proceeds)", async () => {
    const validationEvents = await runAndCollectValidationEvents({
      validator: () => Promise.resolve({ verdict: uncertainVerdict() }),
      llmResponses: [{ content: "borderline response" }],
    });

    expect(validationEvents.length).toEqual(2);
    expect(validationEvents[0]?.data.status).toEqual("running");
    expect(validationEvents[1]?.data.status).toEqual("passed");
    // Uncertain rides through as a `passed` lifecycle event but the verdict
    // itself preserves the underlying status for downstream observability.
    expect(validationEvents[1]?.data.verdict?.status).toEqual("uncertain");
  });

  it("fail then pass on retry → 2 running + 1 failed[terminal=false] + 1 passed", async () => {
    let validatorCalls = 0;
    const validationEvents = await runAndCollectValidationEvents({
      validator: () => {
        validatorCalls++;
        return Promise.resolve({
          verdict: validatorCalls === 1 ? failVerdict("try again") : passVerdict(),
        });
      },
      llmResponses: [{ content: "first bad" }, { content: "second good" }],
    });

    expect(validationEvents.length).toEqual(4);

    expect(validationEvents[0]?.data).toMatchObject({ attempt: 1, status: "running" });

    expect(validationEvents[1]?.data).toMatchObject({
      attempt: 1,
      status: "failed",
      terminal: false,
    });
    expect(validationEvents[1]?.data.verdict?.status).toEqual("fail");

    expect(validationEvents[2]?.data).toMatchObject({ attempt: 2, status: "running" });
    expect(validationEvents[2]?.data.verdict).toBeUndefined();

    expect(validationEvents[3]?.data).toMatchObject({ attempt: 2, status: "passed" });
    expect(validationEvents[3]?.data.verdict?.status).toEqual("pass");
    expect(validationEvents[3]?.data.terminal).toBeUndefined();
  });

  it("fail twice → 2 running + 1 failed[terminal=false] + 1 failed[terminal=true]", async () => {
    const validationEvents = await runAndCollectValidationEvents({
      validator: () => Promise.resolve({ verdict: failVerdict("still wrong") }),
      llmResponses: [{ content: "bad 1" }, { content: "bad 2" }],
      expectThrow: true,
    });

    expect(validationEvents.length).toEqual(4);

    expect(validationEvents[0]?.data).toMatchObject({ attempt: 1, status: "running" });

    expect(validationEvents[1]?.data).toMatchObject({
      attempt: 1,
      status: "failed",
      terminal: false,
    });
    expect(validationEvents[1]?.data.verdict?.status).toEqual("fail");

    expect(validationEvents[2]?.data).toMatchObject({ attempt: 2, status: "running" });

    expect(validationEvents[3]?.data).toMatchObject({
      attempt: 2,
      status: "failed",
      terminal: true,
    });
    expect(validationEvents[3]?.data.verdict?.status).toEqual("fail");
    expect(validationEvents[3]?.data.verdict?.retryGuidance).toEqual("still wrong");
  });

  it("threads abortSignal into the validator on every attempt", async () => {
    const controller = new AbortController();
    const receivedSignals: Array<AbortSignal | undefined> = [];

    const validationEvents = await runAndCollectValidationEvents({
      validator: (_trace, abortSignal) => {
        receivedSignals.push(abortSignal);
        return Promise.resolve({
          verdict: receivedSignals.length === 1 ? failVerdict("retry") : passVerdict(),
        });
      },
      llmResponses: [{ content: "first" }, { content: "second" }],
      abortSignal: controller.signal,
    });

    expect(validationEvents.length).toEqual(4);
    expect(receivedSignals.length).toEqual(2);
    // Both attempts received the same abort signal — propagation is
    // unconditional so aborting mid-validation does not waste tokens.
    expect(receivedSignals[0]).toBe(controller.signal);
    expect(receivedSignals[1]).toBe(controller.signal);
  });
});
