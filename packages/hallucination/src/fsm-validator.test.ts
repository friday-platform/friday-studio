import type { LLMActionTrace } from "@atlas/fsm-engine";
import { describe, expect, it } from "vitest";
import { traceToAgentResult } from "./fsm-validator.ts";

describe("traceToAgentResult", () => {
  it("maps all fields correctly", () => {
    const trace: LLMActionTrace = {
      prompt: "Do the thing",
      content: "I did the thing",
      model: "gpt-4",
    };

    const result = traceToAgentResult(trace);

    expect(result.agentId).toEqual("fsm-llm-action");
    expect(result.task).toEqual("Do the thing");
    expect(result.input).toEqual("Do the thing");
    expect(result.output).toEqual("I did the thing");
    expect(result.duration).toEqual(0);
    // timestamp should be ISO string
    expect(result.timestamp).toBeDefined();
    expect(typeof result.timestamp).toEqual("string");
    // Validate it's parseable as a date
    const parsed = new Date(result.timestamp);
    expect(parsed.toString()).not.toEqual("Invalid Date");
  });

  it("passes through toolCalls directly (AI SDK format)", () => {
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

    expect(result.toolCalls).toBeDefined();
    expect(result.toolCalls!.length).toEqual(2);

    const first = result.toolCalls![0];
    expect(first).toBeDefined();
    expect(first!.toolName).toEqual("read_file");
    expect(first!.input).toEqual({ path: "/foo/bar.txt" });
    expect(first!.type).toEqual("tool-call");
    expect(first!.toolCallId).toEqual("call-1");

    const second = result.toolCalls![1];
    expect(second).toBeDefined();
    expect(second!.toolName).toEqual("write_file");
    expect(second!.input).toEqual({ path: "/baz.txt", content: "hello" });
    expect(second!.toolCallId).toEqual("call-2");
  });

  it("passes through toolResults directly (AI SDK format)", () => {
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

    expect(result.toolResults).toBeDefined();
    expect(result.toolResults!.length).toEqual(2);

    const first = result.toolResults![0];
    expect(first).toBeDefined();
    expect(first!.toolName).toEqual("read_file");
    expect(first!.toolCallId).toEqual("tc-abc123");
    expect(first!.output).toEqual("file contents here");
    expect(first!.type).toEqual("tool-result");

    const second = result.toolResults![1];
    expect(second).toBeDefined();
    expect(second!.toolName).toEqual("search");
    expect(second!.toolCallId).toEqual("tc-xyz789");
    expect(second!.output).toEqual({ matches: ["a", "b"] });
  });

  it("undefined toolCalls/toolResults stay undefined", () => {
    const trace: LLMActionTrace = {
      prompt: "No tools",
      content: "Just text",
      model: "gpt-4",
      // toolCalls and toolResults not set
    };

    const result = traceToAgentResult(trace);

    expect(result.toolCalls).toEqual(undefined);
    expect(result.toolResults).toEqual(undefined);
  });

  it("empty arrays stay as empty arrays", () => {
    const trace: LLMActionTrace = {
      prompt: "Empty tools",
      content: "Nothing",
      model: "gpt-4",
      toolCalls: [],
      toolResults: [],
    };

    const result = traceToAgentResult(trace);

    expect(result.toolCalls).toBeDefined();
    expect(result.toolCalls!.length).toEqual(0);
    expect(result.toolResults).toBeDefined();
    expect(result.toolResults!.length).toEqual(0);
  });

  it("preserves complex nested output exactly", () => {
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
    expect(result.output).toEqual(JSON.stringify(complexOutput));

    // toolCalls input preserved
    expect(result.toolCalls).toBeDefined();
    const toolCall = result.toolCalls![0];
    expect(toolCall).toBeDefined();
    expect(toolCall!.input).toEqual(complexOutput);

    // toolResults output preserved
    expect(result.toolResults).toBeDefined();
    const toolResult = result.toolResults![0];
    expect(toolResult).toBeDefined();
    expect(toolResult!.output).toEqual(complexOutput);
  });

  it("preserves tool call IDs for correlation", () => {
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

    expect(result.toolCalls).toBeDefined();
    expect(result.toolResults).toBeDefined();

    // Tool call IDs should be preserved (AI SDK format)
    expect(result.toolCalls![0]?.toolCallId).toEqual("call-abc-123");
    expect(result.toolCalls![1]?.toolCallId).toEqual("call-def-456");

    // Tool results should still have matching IDs (correlation works)
    expect(result.toolResults![0]?.toolCallId).toEqual("call-abc-123");
    expect(result.toolResults![1]?.toolCallId).toEqual("call-def-456");

    // Correlation: each tool call ID should have a matching result
    for (const call of result.toolCalls!) {
      const matchingResult: unknown = result.toolResults!.find(
        (r) => r.toolCallId === call.toolCallId,
      );
      expect(matchingResult).toBeDefined();
    }
  });
});
