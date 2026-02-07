import type { LLMActionTrace } from "@atlas/fsm-engine";
import { describe, expect, it } from "vitest";
import { traceToAgentResult } from "./fsm-validator.ts";

describe("traceToAgentResult", () => {
  it("maps basic fields correctly", () => {
    const trace: LLMActionTrace = {
      prompt: "Do the thing",
      content: "I did the thing",
      model: "gpt-4",
    };

    const result = traceToAgentResult(trace);

    expect(result).toMatchObject({
      agentId: "fsm-llm-action",
      input: "Do the thing",
      ok: true,
      durationMs: 0,
    });
    if (result.ok) {
      expect(result.data).toEqual("I did the thing");
    }
    expect(new Date(result.timestamp).toString()).not.toEqual("Invalid Date");
  });

  it("passes through toolCalls and toolResults", () => {
    const trace: LLMActionTrace = {
      prompt: "Call tools",
      content: "Done",
      model: "gpt-4",
      toolCalls: [
        { type: "tool-call", toolCallId: "call-1", toolName: "read_file", input: { path: "/foo" } },
        {
          type: "tool-call",
          toolCallId: "call-2",
          toolName: "write_file",
          input: { path: "/bar" },
        },
      ],
      toolResults: [
        {
          type: "tool-result",
          toolCallId: "call-1",
          toolName: "read_file",
          input: {},
          output: "contents",
        },
        {
          type: "tool-result",
          toolCallId: "call-2",
          toolName: "write_file",
          input: {},
          output: { ok: true },
        },
      ],
    };

    const result = traceToAgentResult(trace);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // toolCalls preserved
    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls?.[0]).toMatchObject({
      type: "tool-call",
      toolCallId: "call-1",
      toolName: "read_file",
    });

    // toolResults preserved with correlation IDs
    expect(result.toolResults).toHaveLength(2);
    expect(result.toolResults?.[0]).toMatchObject({
      type: "tool-result",
      toolCallId: "call-1",
      toolName: "read_file",
      output: "contents",
    });
  });

  it("handles missing toolCalls/toolResults", () => {
    const trace: LLMActionTrace = { prompt: "No tools", content: "Just text", model: "gpt-4" };

    const result = traceToAgentResult(trace);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.toolCalls).toBeUndefined();
    expect(result.toolResults).toBeUndefined();
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
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.toolCalls).toBeDefined();
    expect(result.toolCalls?.length).toEqual(0);
    expect(result.toolResults).toBeDefined();
    expect(result.toolResults?.length).toEqual(0);
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
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // content is stringified
    expect(result.data).toEqual(JSON.stringify(complexOutput));

    // toolCalls input preserved
    expect(result.toolCalls).toBeDefined();
    const toolCall = result.toolCalls?.[0];
    expect(toolCall).toBeDefined();
    expect(toolCall?.input).toEqual(complexOutput);

    // toolResults output preserved
    expect(result.toolResults).toBeDefined();
    const toolResult = result.toolResults?.[0];
    expect(toolResult).toBeDefined();
    expect(toolResult?.output).toEqual(complexOutput);
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
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.toolCalls).toBeDefined();
    expect(result.toolResults).toBeDefined();

    // Tool call IDs should be preserved (AI SDK format)
    expect(result.toolCalls?.[0]?.toolCallId).toEqual("call-abc-123");
    expect(result.toolCalls?.[1]?.toolCallId).toEqual("call-def-456");

    // Tool results should still have matching IDs (correlation works)
    expect(result.toolResults?.[0]?.toolCallId).toEqual("call-abc-123");
    expect(result.toolResults?.[1]?.toolCallId).toEqual("call-def-456");

    // Correlation: each tool call ID should have a matching result
    for (const call of result.toolCalls ?? []) {
      const matchingResult = result.toolResults?.find((r) => r.toolCallId === call.toolCallId);
      expect(matchingResult).toBeDefined();
    }
  });
});
