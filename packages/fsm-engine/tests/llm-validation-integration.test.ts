/**
 * LLM Validation Integration Tests
 *
 * These tests use a REAL hallucination detector (calling Haiku) with mock action LLMs.
 * They verify end-to-end hallucination detection behavior in the FSM engine.
 *
 * Characteristics:
 * - Slow (~2-5s per test due to real Haiku calls)
 * - Requires ANTHROPIC_API_KEY environment variable
 * - Skipped in CI environments
 */

import process from "node:process";
import type { AgentResult, ToolCall, ToolResult } from "@atlas/agent-sdk";
import { createFSMOutputValidator } from "@atlas/hallucination";
import { describe, expect, it } from "vitest";
import { getDocumentStore } from "../../document-store/mod.ts";
import { FSMDocumentDataSchema } from "../document-schemas.ts";
import { FSMEngine } from "../fsm-engine.ts";
import type { FSMDefinition, FSMLLMOutput } from "../types.ts";

/**
 * Check if we can run integration tests.
 * Skip if:
 * - Running in CI
 * - No ANTHROPIC_API_KEY available
 */
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const IS_CI = process.env.CI === "true";
const CAN_RUN_INTEGRATION = !IS_CI && Boolean(ANTHROPIC_API_KEY);

/**
 * Mock LLM response format for tests.
 * Simplified format that gets converted to AgentResult.
 */
interface MockLLMResponse {
  content: string;
  data?: { toolCalls?: ToolCall[]; toolResults?: ToolResult[] };
}

/**
 * Convert mock LLM response to AgentResult envelope.
 */
function mockToEnvelope(
  mock: MockLLMResponse,
  agentId: string,
  prompt: string,
): AgentResult<string, FSMLLMOutput> {
  const data: FSMLLMOutput = { response: mock.content };

  return {
    agentId,
    timestamp: new Date().toISOString(),
    input: prompt,
    ok: true,
    data,
    toolCalls: mock.data?.toolCalls,
    toolResults: mock.data?.toolResults,
    durationMs: 0,
  };
}

/**
 * Helper to create an FSM engine with a real validator and mock LLM provider.
 * The validator calls Haiku for hallucination detection.
 * The LLM provider returns scripted responses.
 */
async function createIntegrationEngine(opts: { llmResponses: MockLLMResponse[] }) {
  const store = getDocumentStore();
  const scope = { workspaceId: "integration-test", sessionId: "test-session" };

  const fsm: FSMDefinition = {
    id: "hallucination-integration-test",
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
                prompt: "Process the data and report findings",
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

  // Real validator using Haiku
  const validator = createFSMOutputValidator();

  const engine = new FSMEngine(fsm, {
    documentStore: store,
    scope,
    llmProvider: mockLLMProvider,
    validateOutput: validator,
  });
  await engine.initialize();

  return { engine, store, scope, fsm, getLLMCallCount: () => callCount };
}

describe.skipIf(!CAN_RUN_INTEGRATION)("LLM Validation Integration (Real Haiku)", () => {
  it("detects fabrication when LLM claims data with no tool calls", {
    timeout: 15_000,
  }, async () => {
    // Mock LLM fabricates specific data without any tool access
    const { engine, store, scope, fsm } = await createIntegrationEngine({
      llmResponses: [
        {
          content: "According to the database, there are 1,247 active users and revenue is $2.3M.",
          data: {
            // Empty tool data - no tools were called
            toolCalls: [],
            toolResults: [],
          },
        },
        // Retry response - still fabricating
        {
          content: "Based on my analysis, the system shows 892 pending orders worth $156,000.",
          data: { toolCalls: [], toolResults: [] },
        },
      ],
    });

    // Should throw because both attempts fabricate data
    await expect(async () => await engine.signal({ type: "RUN_LLM" })).rejects.toThrow(
      /failed validation after retry/,
    );

    // State should NOT transition (transaction rolled back)
    expect(engine.state).toEqual("pending");

    // No document should be persisted
    const docResult = await store.read(scope, fsm.id, "output", FSMDocumentDataSchema);
    expect(docResult.ok).toBe(true);
    if (docResult.ok) expect(docResult.data).toEqual(null);
  });

  it("passes legitimate output with tool-sourced data", { timeout: 15_000 }, async () => {
    // Mock LLM returns data that matches tool results (AI SDK format)
    const { engine, store, scope, fsm } = await createIntegrationEngine({
      llmResponses: [
        {
          content: "Found 42 users in the system. The primary contact is Alice Smith at TechCorp.",
          data: {
            toolCalls: [
              { type: "tool-call", toolCallId: "tc1", toolName: "getUserCount", input: {} },
              {
                type: "tool-call",
                toolCallId: "tc2",
                toolName: "getContacts",
                input: { limit: 1 },
              },
            ],
            toolResults: [
              {
                type: "tool-result",
                toolCallId: "tc1",
                toolName: "getUserCount",
                input: {},
                output: { count: 42 },
              },
              {
                type: "tool-result",
                toolCallId: "tc2",
                toolName: "getContacts",
                input: { limit: 1 },
                output: { contacts: [{ name: "Alice Smith", company: "TechCorp" }] },
              },
            ],
          },
        },
      ],
    });

    // Should succeed - data is sourced from tools
    await engine.signal({ type: "RUN_LLM" });

    // State should transition
    expect(engine.state).toEqual("done");

    // Document should be persisted with response
    const docResult = await store.read(scope, fsm.id, "output", FSMDocumentDataSchema);
    expect(docResult.ok).toBe(true);
    if (!docResult.ok) throw new Error(docResult.error);
    expect(docResult.data?.data.data.response).toEqual(
      "Found 42 users in the system. The primary contact is Alice Smith at TechCorp.",
    );
  });

  it("recovers on retry when first attempt fabricates but retry is legitimate", {
    timeout: 15_000,
  }, async () => {
    const { engine, store, scope, fsm, getLLMCallCount } = await createIntegrationEngine({
      llmResponses: [
        // First attempt: fabricates data (no tool results)
        {
          content: "According to internal metrics, there are 5,000 daily active users.",
          data: { toolCalls: [], toolResults: [] },
        },
        // Retry: legitimate response with tool-sourced data (AI SDK format)
        {
          content: "The query returned 127 records from the database.",
          data: {
            toolCalls: [
              {
                type: "tool-call",
                toolCallId: "tc1",
                toolName: "queryDatabase",
                input: { table: "records" },
              },
            ],
            toolResults: [
              {
                type: "tool-result",
                toolCallId: "tc1",
                toolName: "queryDatabase",
                input: { table: "records" },
                output: { rowCount: 127 },
              },
            ],
          },
        },
      ],
    });

    // Should succeed on retry
    await engine.signal({ type: "RUN_LLM" });

    // Should have called LLM twice (initial + retry)
    expect(getLLMCallCount()).toEqual(2);

    // State should transition
    expect(engine.state).toEqual("done");

    // Document should have retry response, not fabricated response
    const docResult = await store.read(scope, fsm.id, "output", FSMDocumentDataSchema);
    expect(docResult.ok).toBe(true);
    if (!docResult.ok) throw new Error(docResult.error);
    expect(docResult.data?.data.data.response).toEqual(
      "The query returned 127 records from the database.",
    );
  });

  it("allows empty output with empty tool results", { timeout: 15_000 }, async () => {
    // Edge case: LLM says "no results" when tools return empty (AI SDK format)
    const { engine, store, scope, fsm } = await createIntegrationEngine({
      llmResponses: [
        {
          content: "No matching records were found in the search.",
          data: {
            toolCalls: [
              {
                type: "tool-call",
                toolCallId: "tc1",
                toolName: "search",
                input: { query: "nonexistent" },
              },
            ],
            toolResults: [
              {
                type: "tool-result",
                toolCallId: "tc1",
                toolName: "search",
                input: { query: "nonexistent" },
                output: { results: [], count: 0 },
              },
            ],
          },
        },
      ],
    });

    // Should pass - "no results" is consistent with empty tool results
    await engine.signal({ type: "RUN_LLM" });

    expect(engine.state).toEqual("done");

    const docResult = await store.read(scope, fsm.id, "output", FSMDocumentDataSchema);
    expect(docResult.ok).toBe(true);
    if (!docResult.ok) throw new Error(docResult.error);
    expect(docResult.data?.data.data.response).toEqual(
      "No matching records were found in the search.",
    );
  });
});

// Additional describe block to verify test skip behavior
describe("Integration Test Prerequisites", () => {
  it("reports environment status", () => {
    console.log(`Integration tests ${CAN_RUN_INTEGRATION ? "ENABLED" : "SKIPPED"}`);
    console.log(`  - CI environment: ${IS_CI}`);
    console.log(`  - ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY ? "present" : "missing"}`);
  });
});
