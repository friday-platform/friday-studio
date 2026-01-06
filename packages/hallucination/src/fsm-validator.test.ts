import type { LLMActionTrace } from "@atlas/fsm-engine";
import { assertEquals, assertExists, assertNotEquals } from "@std/assert";
import { traceToAgentResult } from "./fsm-validator.ts";

Deno.test("traceToAgentResult maps all fields correctly", () => {
  const trace: LLMActionTrace = {
    prompt: "Do the thing",
    content: "I did the thing",
    model: "gpt-4",
  };

  const result = traceToAgentResult(trace);

  assertEquals(result.agentId, "fsm-llm-action");
  assertEquals(result.task, "Do the thing");
  assertEquals(result.input, "Do the thing");
  assertEquals(result.output, "I did the thing");
  assertEquals(result.duration, 0);
  // timestamp should be ISO string
  assertExists(result.timestamp);
  assertEquals(typeof result.timestamp, "string");
  // Validate it's parseable as a date
  const parsed = new Date(result.timestamp);
  assertNotEquals(parsed.toString(), "Invalid Date");
});

Deno.test("traceToAgentResult passes through toolCalls directly (AI SDK format)", () => {
  const trace: LLMActionTrace = {
    prompt: "Call a tool",
    content: "Called it",
    model: "gpt-4",
    toolCalls: [
      {
        type: "tool-call",
        toolCallId: "call-1",
        toolName: "read_file",
        input: { path: "/foo/bar.txt" },
      },
      {
        type: "tool-call",
        toolCallId: "call-2",
        toolName: "write_file",
        input: { path: "/baz.txt", content: "hello" },
      },
    ],
  };

  const result = traceToAgentResult(trace);

  assertExists(result.toolCalls);
  assertEquals(result.toolCalls.length, 2);

  const first = result.toolCalls[0];
  assertExists(first);
  assertEquals(first.toolName, "read_file");
  assertEquals(first.input, { path: "/foo/bar.txt" });
  assertEquals(first.type, "tool-call");
  assertEquals(first.toolCallId, "call-1");

  const second = result.toolCalls[1];
  assertExists(second);
  assertEquals(second.toolName, "write_file");
  assertEquals(second.input, { path: "/baz.txt", content: "hello" });
  assertEquals(second.toolCallId, "call-2");
});

Deno.test("traceToAgentResult passes through toolResults directly (AI SDK format)", () => {
  const trace: LLMActionTrace = {
    prompt: "Get tool results",
    content: "Got em",
    model: "gpt-4",
    toolResults: [
      {
        type: "tool-result",
        toolName: "read_file",
        toolCallId: "tc-abc123",
        input: {},
        output: "file contents here",
      },
      {
        type: "tool-result",
        toolName: "search",
        toolCallId: "tc-xyz789",
        input: {},
        output: { matches: ["a", "b"] },
      },
    ],
  };

  const result = traceToAgentResult(trace);

  assertExists(result.toolResults);
  assertEquals(result.toolResults.length, 2);

  const first = result.toolResults[0];
  assertExists(first);
  assertEquals(first.toolName, "read_file");
  assertEquals(first.toolCallId, "tc-abc123");
  assertEquals(first.output, "file contents here");
  assertEquals(first.type, "tool-result");

  const second = result.toolResults[1];
  assertExists(second);
  assertEquals(second.toolName, "search");
  assertEquals(second.toolCallId, "tc-xyz789");
  assertEquals(second.output, { matches: ["a", "b"] });
});

Deno.test("traceToAgentResult: undefined toolCalls/toolResults stay undefined", () => {
  const trace: LLMActionTrace = {
    prompt: "No tools",
    content: "Just text",
    model: "gpt-4",
    // toolCalls and toolResults not set
  };

  const result = traceToAgentResult(trace);

  assertEquals(result.toolCalls, undefined);
  assertEquals(result.toolResults, undefined);
});

Deno.test("traceToAgentResult: empty arrays stay as empty arrays", () => {
  const trace: LLMActionTrace = {
    prompt: "Empty tools",
    content: "Nothing",
    model: "gpt-4",
    toolCalls: [],
    toolResults: [],
  };

  const result = traceToAgentResult(trace);

  assertExists(result.toolCalls);
  assertEquals(result.toolCalls.length, 0);
  assertExists(result.toolResults);
  assertEquals(result.toolResults.length, 0);
});

Deno.test("traceToAgentResult preserves complex nested output exactly", () => {
  const complexOutput = {
    level1: {
      level2: {
        level3: { array: [1, 2, { nested: true }], null: null, number: 42.5, bool: false },
      },
      sibling: ["a", "b", "c"],
    },
    topLevel: "value",
  };

  const trace: LLMActionTrace = {
    prompt: "complex",
    content: JSON.stringify(complexOutput),
    model: "gpt-4",
    toolCalls: [
      { type: "tool-call", toolCallId: "tc-1", toolName: "complex_tool", input: complexOutput },
    ],
    toolResults: [
      {
        type: "tool-result",
        toolCallId: "tc-1",
        toolName: "complex_tool",
        input: {},
        output: complexOutput,
      },
    ],
  };

  const result = traceToAgentResult(trace);

  // content is stringified
  assertEquals(result.output, JSON.stringify(complexOutput));

  // toolCalls input preserved
  assertExists(result.toolCalls);
  const toolCall = result.toolCalls[0];
  assertExists(toolCall);
  assertEquals(toolCall.input, complexOutput);

  // toolResults output preserved
  assertExists(result.toolResults);
  const toolResult = result.toolResults[0];
  assertExists(toolResult);
  assertEquals(toolResult.output, complexOutput);
});

Deno.test("traceToAgentResult preserves tool call IDs for correlation", () => {
  const trace: LLMActionTrace = {
    prompt: "Calls with results",
    content: "Done",
    model: "gpt-4",
    toolCalls: [
      { type: "tool-call", toolCallId: "call-abc-123", toolName: "tool_a", input: { x: 1 } },
      { type: "tool-call", toolCallId: "call-def-456", toolName: "tool_b", input: { y: 2 } },
    ],
    toolResults: [
      {
        type: "tool-result",
        toolCallId: "call-abc-123",
        toolName: "tool_a",
        input: { x: 1 },
        output: "result a",
      },
      {
        type: "tool-result",
        toolCallId: "call-def-456",
        toolName: "tool_b",
        input: { y: 2 },
        output: "result b",
      },
    ],
  };

  const result = traceToAgentResult(trace);

  assertExists(result.toolCalls);
  assertExists(result.toolResults);

  // Tool call IDs should be preserved (AI SDK format)
  assertEquals(result.toolCalls[0]?.toolCallId, "call-abc-123");
  assertEquals(result.toolCalls[1]?.toolCallId, "call-def-456");

  // Tool results should still have matching IDs (correlation works)
  assertEquals(result.toolResults[0]?.toolCallId, "call-abc-123");
  assertEquals(result.toolResults[1]?.toolCallId, "call-def-456");

  // Correlation: each tool call ID should have a matching result
  for (const call of result.toolCalls) {
    const matchingResult: unknown = result.toolResults.find(
      (r) => r.toolCallId === call.toolCallId,
    );
    assertExists(matchingResult, `No matching result for tool call ${call.toolCallId}`);
  }
});
