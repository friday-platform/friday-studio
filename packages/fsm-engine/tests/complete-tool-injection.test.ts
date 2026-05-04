import type { AgentResult, ToolCall } from "@atlas/agent-sdk";
import type { ValidationVerdict } from "@atlas/hallucination";
import { describe, expect, it } from "vitest";
import { getDocumentStore } from "../../document-store/mod.ts";
import { FSMDocumentDataSchema } from "../document-schemas.ts";
import { FSMEngine } from "../fsm-engine.ts";
import type { FSMDefinition, FSMLLMOutput, LLMProvider, OutputValidator } from "../types.ts";

function passVerdict(): ValidationVerdict {
  return { status: "pass", confidence: 0.9, threshold: 0.45, issues: [], retryGuidance: "" };
}

function failVerdict(retryGuidance: string): ValidationVerdict {
  return { status: "fail", confidence: 0.1, threshold: 0.45, issues: [], retryGuidance };
}

/** Mock LLM response - simplified format converted to AgentResult */
interface MockLLMResponse {
  content: string;
  calledTool?: { name: string; args: unknown };
  data?: { toolCalls?: ToolCall[]; toolResults?: unknown[]; [key: string]: unknown };
}

/** Convert mock response to AgentResult (mirrors real adapter behavior) */
function mockToEnvelope(
  mock: MockLLMResponse,
  agentId: string,
  prompt: string,
): AgentResult<string, FSMLLMOutput> {
  const toolCalls: ToolCall[] = mock.data?.toolCalls ?? [];

  // Merge calledTool shorthand into toolCalls array
  if (mock.calledTool && !toolCalls.some((tc) => tc.toolName === mock.calledTool?.name)) {
    toolCalls.unshift({
      type: "tool-call",
      toolCallId: `mock-${mock.calledTool.name}`,
      toolName: mock.calledTool.name,
      input: mock.calledTool.args,
    });
  }

  // Raw text - FSM engine extracts structured output from toolCalls
  const data: FSMLLMOutput = { response: mock.content };

  return {
    agentId,
    timestamp: new Date().toISOString(),
    input: prompt,
    ok: true,
    data,
    toolCalls,
    durationMs: 0,
  };
}

/**
 * Tests for `complete` tool injection. When outputTo targets a document with
 * a defined schema, FSM injects a `complete` tool. LLM calls it with structured
 * data matching the schema.
 */
describe("complete tool injection for LLM actions", () => {
  async function createLLMEngine(opts: {
    fsm: FSMDefinition;
    llmResponses: MockLLMResponse[];
    validator?: OutputValidator;
  }) {
    const store = getDocumentStore();
    const scope = {
      workspaceId: `test-${crypto.randomUUID()}`,
      sessionId: `test-session-${crypto.randomUUID()}`,
    };

    let callCount = 0;
    const capturedPrompts: string[] = [];
    const capturedTools: string[][] = [];

    const mockLLMProvider: LLMProvider = {
      call: (params) => {
        capturedPrompts.push(params.prompt);
        capturedTools.push(Object.keys(params.tools ?? {}));

        const mockResponse =
          opts.llmResponses[callCount] ?? opts.llmResponses[opts.llmResponses.length - 1];
        callCount++;
        if (!mockResponse) {
          throw new Error("No LLM response available for mock");
        }
        return Promise.resolve(mockToEnvelope(mockResponse, params.agentId, params.prompt));
      },
    };

    const engine = new FSMEngine(opts.fsm, {
      documentStore: store,
      scope,
      llmProvider: mockLLMProvider,
      validateOutput: opts.validator,
    });
    await engine.initialize();

    return {
      engine,
      store,
      scope,
      getCapturedPrompts: () => capturedPrompts,
      getCapturedTools: () => capturedTools,
      getLLMCallCount: () => callCount,
    };
  }

  it("injects complete tool when outputTo document type has properties defined", async () => {
    // Document type has properties but no required fields - allows empty initial data
    const fsm: FSMDefinition = {
      id: "complete-tool-test",
      initial: "pending",
      states: {
        pending: {
          documents: [{ id: "result", type: "TicketResult", data: {} }],
          on: {
            RUN: {
              target: "done",
              actions: [
                {
                  type: "llm",
                  provider: "test",
                  model: "test-model",
                  prompt: "Extract ticket info",
                  outputTo: "result",
                },
              ],
            },
          },
        },
        done: { type: "final" },
      },
      documentTypes: {
        TicketResult: {
          type: "object",
          properties: {
            ticket_id: { type: "string" },
            priority: { type: "string", enum: ["low", "medium", "high"] },
          },
          // No required fields - allows empty initial document
        },
      },
    };

    const { engine, getCapturedTools } = await createLLMEngine({
      fsm,
      llmResponses: [{ content: "Extracted info" }],
    });

    await engine.signal({ type: "RUN" });

    // Verify complete tool was injected
    const toolsProvided = getCapturedTools()[0];
    expect(toolsProvided).toContain("complete");
    expect(toolsProvided).toContain("failStep"); // Should still have failStep
  });

  it("stores structured data when LLM calls complete tool", async () => {
    const fsm: FSMDefinition = {
      id: "complete-tool-data-test",
      initial: "pending",
      states: {
        pending: {
          documents: [{ id: "result", type: "TicketResult", data: {} }],
          on: {
            RUN: {
              target: "done",
              actions: [
                {
                  type: "llm",
                  provider: "test",
                  model: "test-model",
                  prompt: "Extract ticket info",
                  outputTo: "result",
                },
              ],
            },
          },
        },
        done: { type: "final" },
      },
      documentTypes: {
        TicketResult: {
          type: "object",
          properties: {
            ticket_id: { type: "string" },
            priority: { type: "string", enum: ["low", "medium", "high"] },
          },
        },
      },
    };

    const { engine, store, scope } = await createLLMEngine({
      fsm,
      llmResponses: [
        {
          content: "",
          calledTool: { name: "complete", args: { ticket_id: "PROJ-123", priority: "high" } },
        },
      ],
    });

    await engine.signal({ type: "RUN" });

    // Verify structured data was stored (not raw LLM response)
    const docResult = await store.read(scope, fsm.id, "result", FSMDocumentDataSchema);
    expect(docResult.ok).toBe(true);
    if (!docResult.ok) throw new Error(docResult.error);
    expect(docResult.data?.data.data.ticket_id).toEqual("PROJ-123");
    expect(docResult.data?.data.data.priority).toEqual("high");
    // Should NOT have toolCalls/toolResults from raw response
    expect(docResult.data?.data.data.toolCalls).toBeUndefined();
  });

  it("does NOT inject complete tool when document type has no properties", async () => {
    const fsm: FSMDefinition = {
      id: "no-complete-tool-test",
      initial: "pending",
      states: {
        pending: {
          documents: [{ id: "result", type: "GenericResult", data: {} }],
          on: {
            RUN: {
              target: "done",
              actions: [
                {
                  type: "llm",
                  provider: "test",
                  model: "test-model",
                  prompt: "Do something",
                  outputTo: "result",
                },
              ],
            },
          },
        },
        done: { type: "final" },
      },
      documentTypes: {
        GenericResult: {
          type: "object",
          additionalProperties: true, // Catch-all, no properties defined
        },
      },
    };

    const { engine, getCapturedTools } = await createLLMEngine({
      fsm,
      llmResponses: [{ content: "done" }],
    });

    await engine.signal({ type: "RUN" });

    // Verify complete tool was NOT injected
    const toolsProvided = getCapturedTools()[0];
    expect(toolsProvided).not.toContain("complete");
    expect(toolsProvided).toContain("failStep"); // Should still have failStep
  });

  it("falls back to raw response storage when LLM does not call complete", async () => {
    const fsm: FSMDefinition = {
      id: "fallback-test",
      initial: "pending",
      states: {
        pending: {
          documents: [{ id: "result", type: "TicketResult", data: {} }],
          on: {
            RUN: {
              target: "done",
              actions: [
                {
                  type: "llm",
                  provider: "test",
                  model: "test-model",
                  prompt: "Extract ticket info",
                  outputTo: "result",
                },
              ],
            },
          },
        },
        done: { type: "final" },
      },
      documentTypes: {
        TicketResult: {
          type: "object",
          properties: { ticket_id: { type: "string" } },
          // No required - allows fallback to raw response
        },
      },
    };

    const { engine, store, scope } = await createLLMEngine({
      fsm,
      llmResponses: [{ content: "I found ticket PROJ-456" }],
    });

    await engine.signal({ type: "RUN" });

    // Verify raw response was stored (fallback behavior) - now uses { response: string }
    const docResult = await store.read(scope, fsm.id, "result", FSMDocumentDataSchema);
    expect(docResult.ok).toBe(true);
    if (!docResult.ok) throw new Error(docResult.error);
    expect(docResult.data?.data.data.response).toEqual("I found ticket PROJ-456");
  });

  it("augments prompt with complete tool instruction", async () => {
    const fsm: FSMDefinition = {
      id: "prompt-augment-test",
      initial: "pending",
      states: {
        pending: {
          documents: [{ id: "result", type: "TicketResult", data: {} }],
          on: {
            RUN: {
              target: "done",
              actions: [
                {
                  type: "llm",
                  provider: "test",
                  model: "test-model",
                  prompt: "Extract ticket info",
                  outputTo: "result",
                },
              ],
            },
          },
        },
        done: { type: "final" },
      },
      documentTypes: {
        TicketResult: { type: "object", properties: { ticket_id: { type: "string" } } },
      },
    };

    const { engine, getCapturedPrompts } = await createLLMEngine({
      fsm,
      llmResponses: [{ content: "done" }],
    });

    await engine.signal({ type: "RUN" });

    // Verify prompt includes complete tool instruction
    const prompt = getCapturedPrompts()[0];
    expect(prompt).toContain("complete");
    expect(prompt).toContain("MUST");
  });

  it("existing LLM actions without outputTo continue to work", async () => {
    const fsm: FSMDefinition = {
      id: "no-output-test",
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
                  prompt: "Just respond",
                  // No outputTo
                },
              ],
            },
          },
        },
        done: { type: "final" },
      },
    };

    const { engine, getCapturedTools } = await createLLMEngine({
      fsm,
      llmResponses: [{ content: "response" }],
    });

    await engine.signal({ type: "RUN" });

    // Should complete without error
    expect(engine.state).toEqual("done");

    // Should only have failStep, not complete
    const toolsProvided = getCapturedTools()[0];
    expect(toolsProvided).toContain("failStep");
    expect(toolsProvided).not.toContain("complete");
  });

  it("uses outputType to look up schema when document does not exist", async () => {
    // This tests the scenario where outputTo specifies a document ID that doesn't exist yet.
    // The outputType field provides explicit mapping to the document type for schema lookup.
    const fsm: FSMDefinition = {
      id: "output-type-test",
      initial: "pending",
      states: {
        pending: {
          // No documents declared - the document will be created dynamically
          on: {
            RUN: {
              target: "done",
              actions: [
                {
                  type: "llm",
                  provider: "test",
                  model: "test-model",
                  prompt: "Extract ticket info",
                  outputTo: "linear_ticket_reader_result",
                  outputType: "LinearTicketReaderResult", // Explicit type mapping
                },
              ],
            },
          },
        },
        done: { type: "final" },
      },
      documentTypes: {
        LinearTicketReaderResult: {
          type: "object",
          properties: { ticket_id: { type: "string" }, title: { type: "string" } },
        },
      },
    };

    const { engine, getCapturedTools, store, scope } = await createLLMEngine({
      fsm,
      llmResponses: [
        {
          content: "",
          calledTool: { name: "complete", args: { ticket_id: "PROJ-123", title: "Fix bug" } },
        },
      ],
    });

    await engine.signal({ type: "RUN" });

    // Verify complete tool was injected (outputType enabled schema lookup)
    const toolsProvided = getCapturedTools()[0];
    expect(toolsProvided).toContain("complete");
    expect(toolsProvided).toContain("failStep");

    // Verify structured data was stored
    const docResult = await store.read(
      scope,
      fsm.id,
      "linear_ticket_reader_result",
      FSMDocumentDataSchema,
    );
    expect(docResult.ok).toBe(true);
    if (!docResult.ok) throw new Error(docResult.error);
    expect(docResult.data?.data.data.ticket_id).toEqual("PROJ-123");
    expect(docResult.data?.data.data.title).toEqual("Fix bug");
  });

  it("prefers outputType over document.type when both exist", async () => {
    // When a document exists with one type but outputType specifies a different type,
    // outputType takes precedence for schema lookup
    const fsm: FSMDefinition = {
      id: "output-type-precedence-test",
      initial: "pending",
      states: {
        pending: {
          documents: [
            // Document exists with GenericResult type (no properties)
            { id: "result", type: "GenericResult", data: {} },
          ],
          on: {
            RUN: {
              target: "done",
              actions: [
                {
                  type: "llm",
                  provider: "test",
                  model: "test-model",
                  prompt: "Extract info",
                  outputTo: "result",
                  outputType: "StructuredResult", // Override to use structured schema
                },
              ],
            },
          },
        },
        done: { type: "final" },
      },
      documentTypes: {
        GenericResult: {
          type: "object",
          additionalProperties: true, // Catch-all, no complete tool
        },
        StructuredResult: { type: "object", properties: { status: { type: "string" } } },
      },
    };

    const { engine, getCapturedTools } = await createLLMEngine({
      fsm,
      llmResponses: [{ content: "done" }],
    });

    await engine.signal({ type: "RUN" });

    // Verify complete tool was injected (outputType took precedence)
    const toolsProvided = getCapturedTools()[0];
    expect(toolsProvided).toContain("complete");
  });

  it("gracefully handles outputType when type is not defined in documentTypes", async () => {
    // When outputType references a non-existent type, should fall back gracefully
    // (no complete tool injection, but no error)
    const fsm: FSMDefinition = {
      id: "output-type-missing-test",
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
                  prompt: "Do something",
                  outputTo: "result",
                  outputType: "NonExistentType", // Type not defined
                },
              ],
            },
          },
        },
        done: { type: "final" },
      },
      documentTypes: { SomeOtherType: { type: "object", properties: { foo: { type: "string" } } } },
    };

    const { engine, getCapturedTools } = await createLLMEngine({
      fsm,
      llmResponses: [{ content: "done" }],
    });

    await engine.signal({ type: "RUN" });

    // Should complete without error
    expect(engine.state).toEqual("done");

    // Should NOT have complete tool (type not found)
    const toolsProvided = getCapturedTools()[0];
    expect(toolsProvided).not.toContain("complete");
    expect(toolsProvided).toContain("failStep");
  });

  it("captures complete tool output on retry after validation failure", async () => {
    // This test verifies the fix for the bug where complete tool output was not
    // captured when the LLM was retried after validation failure.
    const fsm: FSMDefinition = {
      id: "complete-retry-test",
      initial: "pending",
      states: {
        pending: {
          documents: [{ id: "result", type: "TicketResult", data: {} }],
          on: {
            RUN: {
              target: "done",
              actions: [
                {
                  type: "llm",
                  provider: "test",
                  model: "test-model",
                  prompt: "Extract ticket info",
                  outputTo: "result",
                },
              ],
            },
          },
        },
        done: { type: "final" },
      },
      documentTypes: {
        TicketResult: {
          type: "object",
          properties: {
            ticket_id: { type: "string" },
            priority: { type: "string", enum: ["low", "medium", "high"] },
          },
        },
      },
    };

    const { engine, store, scope, getLLMCallCount } = await createLLMEngine({
      fsm,
      validator: (trace) => {
        // Fail first attempt (no complete tool call), pass on retry
        if (trace.content === "first attempt without structured output") {
          return Promise.resolve({ verdict: failVerdict("Call complete tool") });
        }
        return Promise.resolve({ verdict: passVerdict() });
      },
      llmResponses: [
        // First attempt: LLM responds with text only (fails validation)
        { content: "first attempt without structured output" },
        // Retry: LLM calls complete tool with structured data (passes validation)
        {
          content: "",
          calledTool: { name: "complete", args: { ticket_id: "RETRY-456", priority: "medium" } },
        },
      ],
    });

    await engine.signal({ type: "RUN" });

    // Verify two LLM calls were made (initial + retry)
    expect(getLLMCallCount()).toEqual(2);

    // Verify state transitioned successfully
    expect(engine.state).toEqual("done");

    // Verify the retry's complete tool output was captured and stored
    const docResult = await store.read(scope, fsm.id, "result", FSMDocumentDataSchema);
    expect(docResult.ok).toBe(true);
    if (!docResult.ok) throw new Error(docResult.error);
    expect(docResult.data?.data.data.ticket_id).toEqual("RETRY-456");
    expect(docResult.data?.data.data.priority).toEqual("medium");
    // Should NOT have raw response content (structured data took precedence)
    expect(docResult.data?.data.data.content).toBeUndefined();
  });

  it("captures complete tool output when LLM calls other tools first (multi-step)", async () => {
    // BUG REGRESSION TEST: In real multi-step scenarios, the LLM calls MCP tools
    // (e.g., linear.get_issue) before calling `complete`. The adapter builds
    // `calledTool` from `assembledToolCalls[0]` — the FIRST tool call — which is
    // the MCP tool, not `complete`. The engine checks `calledTool.name === "complete"`
    // which evaluates to false, silently falling back to raw response storage.
    //
    // This test simulates the real adapter output: calledTool points to the first
    // MCP tool, while `complete` args are only in the data.toolCalls array.
    const fsm: FSMDefinition = {
      id: "multi-step-complete-test",
      initial: "pending",
      states: {
        pending: {
          documents: [{ id: "result", type: "TicketResult", data: {} }],
          on: {
            RUN: {
              target: "done",
              actions: [
                {
                  type: "llm",
                  provider: "test",
                  model: "test-model",
                  prompt: "Fetch ticket and extract info",
                  outputTo: "result",
                },
              ],
            },
          },
        },
        done: { type: "final" },
      },
      documentTypes: {
        TicketResult: {
          type: "object",
          properties: {
            ticket_id: { type: "string" },
            priority: { type: "string", enum: ["low", "medium", "high"] },
          },
        },
      },
    };

    const { engine, store, scope } = await createLLMEngine({
      fsm,
      llmResponses: [
        {
          // Simulate real adapter output for multi-step: LLM called linear.get_issue
          // (step 1) then complete (step 2). The adapter sets calledTool from
          // assembledToolCalls[0] which is linear.get_issue, NOT complete.
          content: "",
          calledTool: { name: "linear.get_issue", args: { issueId: "PROJ-123" } },
          data: {
            toolCalls: [
              {
                type: "tool-call",
                toolCallId: "call-1",
                toolName: "linear.get_issue",
                input: { issueId: "PROJ-123" },
              },
              {
                type: "tool-call",
                toolCallId: "call-2",
                toolName: "complete",
                input: { ticket_id: "PROJ-123", priority: "high" },
              },
            ],
            toolResults: [],
          },
        },
      ],
    });

    await engine.signal({ type: "RUN" });

    // Verify structured data was captured from the complete tool call
    const docResult = await store.read(scope, fsm.id, "result", FSMDocumentDataSchema);
    expect(docResult.ok).toBe(true);
    if (!docResult.ok) throw new Error(docResult.error);
    expect(docResult.data?.data.data.ticket_id).toEqual("PROJ-123");
    expect(docResult.data?.data.data.priority).toEqual("high");
    // Should NOT have raw toolCalls array stored as data
    expect(docResult.data?.data.data.toolCalls).toBeUndefined();
  });

  it("detects failStep when it is the only tool called", async () => {
    const fsm: FSMDefinition = {
      id: "failstep-only-test",
      initial: "pending",
      states: {
        pending: {
          on: {
            RUN: {
              target: "done",
              actions: [
                { type: "llm", provider: "test", model: "test-model", prompt: "Do something" },
              ],
            },
          },
        },
        done: { type: "final" },
      },
    };

    const { engine } = await createLLMEngine({
      fsm,
      llmResponses: [
        { content: "", calledTool: { name: "failStep", args: { reason: "Cannot proceed" } } },
      ],
    });

    await expect(engine.signal({ type: "RUN" })).rejects.toThrow("LLM step failed");
  });

  it("detects failStep when LLM calls other tools first (multi-tool)", async () => {
    const fsm: FSMDefinition = {
      id: "failstep-multi-tool-test",
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
                  prompt: "Fetch data and process",
                },
              ],
            },
          },
        },
        done: { type: "final" },
      },
    };

    const { engine } = await createLLMEngine({
      fsm,
      llmResponses: [
        {
          // calledTool is the first tool (artifacts_get), NOT failStep
          content: "",
          calledTool: { name: "artifacts_get", args: { id: "doc-1" } },
          data: {
            toolCalls: [
              {
                type: "tool-call",
                toolCallId: "call-1",
                toolName: "artifacts_get",
                input: { id: "doc-1" },
              },
              {
                type: "tool-call",
                toolCallId: "call-2",
                toolName: "failStep",
                input: { reason: "Missing required data" },
              },
            ],
            toolResults: [],
          },
        },
      ],
    });

    await expect(engine.signal({ type: "RUN" })).rejects.toThrow(
      /LLM step failed.*Missing required data/,
    );
  });

  it("does not false-positive on failStep when LLM calls complete", async () => {
    const fsm: FSMDefinition = {
      id: "no-false-failstep-test",
      initial: "pending",
      states: {
        pending: {
          documents: [{ id: "result", type: "TicketResult", data: {} }],
          on: {
            RUN: {
              target: "done",
              actions: [
                {
                  type: "llm",
                  provider: "test",
                  model: "test-model",
                  prompt: "Extract info",
                  outputTo: "result",
                },
              ],
            },
          },
        },
        done: { type: "final" },
      },
      documentTypes: {
        TicketResult: { type: "object", properties: { ticket_id: { type: "string" } } },
      },
    };

    const { engine } = await createLLMEngine({
      fsm,
      llmResponses: [
        { content: "", calledTool: { name: "complete", args: { ticket_id: "OK-1" } } },
      ],
    });

    // Should NOT throw — complete is not failStep
    await engine.signal({ type: "RUN" });
    expect(engine.state).toEqual("done");
  });

  it("falls through when LLM calls neither complete nor failStep", async () => {
    const fsm: FSMDefinition = {
      id: "neither-tool-test",
      initial: "pending",
      states: {
        pending: {
          documents: [{ id: "result", type: "GenericResult", data: {} }],
          on: {
            RUN: {
              target: "done",
              actions: [
                {
                  type: "llm",
                  provider: "test",
                  model: "test-model",
                  prompt: "Do something",
                  outputTo: "result",
                },
              ],
            },
          },
        },
        done: { type: "final" },
      },
      documentTypes: { GenericResult: { type: "object", additionalProperties: true } },
    };

    const { engine } = await createLLMEngine({
      fsm,
      llmResponses: [{ content: "just text response" }],
    });

    // Should succeed — falls through to normal storage path
    await engine.signal({ type: "RUN" });
    expect(engine.state).toEqual("done");
  });

  it("detects failStep on retry after validation failure (multi-tool)", async () => {
    const fsm: FSMDefinition = {
      id: "failstep-retry-multi-test",
      initial: "pending",
      states: {
        pending: {
          documents: [{ id: "result", type: "TicketResult", data: {} }],
          on: {
            RUN: {
              target: "done",
              actions: [
                {
                  type: "llm",
                  provider: "test",
                  model: "test-model",
                  prompt: "Extract info",
                  outputTo: "result",
                },
              ],
            },
          },
        },
        done: { type: "final" },
      },
      documentTypes: {
        TicketResult: { type: "object", properties: { ticket_id: { type: "string" } } },
      },
    };

    const { engine } = await createLLMEngine({
      fsm,
      validator: (trace) => {
        if (trace.content === "first attempt") {
          return Promise.resolve({ verdict: failVerdict("Try again") });
        }
        return Promise.resolve({ verdict: passVerdict() });
      },
      llmResponses: [
        // First attempt: text only, fails validation
        { content: "first attempt" },
        // Retry: calls artifacts_get then failStep
        {
          content: "",
          calledTool: { name: "artifacts_get", args: { id: "doc-1" } },
          data: {
            toolCalls: [
              {
                type: "tool-call",
                toolCallId: "call-1",
                toolName: "artifacts_get",
                input: { id: "doc-1" },
              },
              {
                type: "tool-call",
                toolCallId: "call-2",
                toolName: "failStep",
                input: { reason: "Gave up on retry" },
              },
            ],
            toolResults: [],
          },
        },
      ],
    });

    await expect(engine.signal({ type: "RUN" })).rejects.toThrow("LLM step failed on retry");
  });
});
