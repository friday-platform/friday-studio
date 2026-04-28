import type { LLMActionTrace } from "@atlas/fsm-engine";
import { describe, expect, it } from "vitest";
import { formatToolResults } from "./detector.ts";
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

  it("preserves tool call IDs for correlation (AI SDK format)", () => {
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

describe("formatToolResults", () => {
  /** Helper to build a typed ToolResult with MCP-shaped output. */
  function mcpResult(
    toolName: string,
    textContent: string,
    callId = "call-1",
  ): {
    type: "tool-result";
    toolCallId: string;
    toolName: string;
    input: unknown;
    output: unknown;
  } {
    return {
      type: "tool-result",
      toolCallId: callId,
      toolName,
      input: {},
      output: { content: [{ type: "text", text: textContent }] },
    };
  }

  it("extracts text content from MCP tool results", () => {
    const results = [
      mcpResult("linear_search_issues", '{"id":"TEM-100","title":"Fix bug"}'),
      mcpResult("linear_search_issues", '{"id":"TEM-101","title":"Add feature"}'),
    ];

    const formatted = formatToolResults(results);

    expect(formatted).toContain("=== Tool Result 1: linear_search_issues | input: {} ===");
    expect(formatted).toContain("=== Tool Result 2: linear_search_issues | input: {} ===");
    expect(formatted).toContain("TEM-100");
    expect(formatted).toContain("TEM-101");
    expect(formatted).not.toContain("…");
  });

  it("includes tool name in header for each result", () => {
    const results = [
      mcpResult("linear_search_issues", "issues data"),
      mcpResult("linear_get_issue", "single issue"),
    ];

    const formatted = formatToolResults(results);

    expect(formatted).toContain("linear_search_issues");
    expect(formatted).toContain("linear_get_issue");
  });

  it("includes input and strips envelope noise (toolCallId, type metadata)", () => {
    const results = [
      {
        type: "tool-result" as const,
        toolCallId: "call-abc-123",
        toolName: "linear_search",
        input: { query: "assignee:me" },
        output: { content: [{ type: "text", text: "the actual data" }] },
      },
    ];

    const formatted = formatToolResults(results);

    // Should contain tool name and input
    expect(formatted).toContain("linear_search");
    expect(formatted).toContain("assignee:me");
    // Should NOT contain envelope fields
    expect(formatted).not.toContain("call-abc-123");
    expect(formatted).not.toContain('"type":"tool-result"');
    // Should contain the actual data
    expect(formatted).toContain("the actual data");
  });

  it("preserves all issues in a large Linear-like MCP result", () => {
    // Simulate Linear returning 50 issues as MCP text content
    const issues = Array.from({ length: 50 }, (_, i) => ({
      id: `TEM-${3000 + i}`,
      title: `Issue title for ${3000 + i}`,
      status: ["Todo", "In Progress", "Done", "Backlog"][i % 4],
      priority: i % 5,
      assignee: { name: "Alex Doe", email: "alex@example.com" },
    }));
    const results = [mcpResult("linear_search_issues", JSON.stringify(issues))];

    const formatted = formatToolResults(results);

    for (const issue of issues) {
      expect(formatted).toContain(issue.id);
    }
    expect(formatted).not.toContain("…");
  });

  it("truncates individual results exceeding 50k chars", () => {
    const hugePayload = "x".repeat(60_000);
    const results = [mcpResult("big_tool", hugePayload)];

    const formatted = formatToolResults(results);

    expect(formatted).toContain("…");
    expect(formatted.length).toBeLessThan(60_000);
  });

  it("falls back to JSON for non-MCP output shapes", () => {
    const results = [
      {
        type: "tool-result" as const,
        toolCallId: "call-1",
        toolName: "custom_tool",
        input: {},
        output: { someField: "value", nested: { deep: true } },
      },
    ];

    const formatted = formatToolResults(results);

    expect(formatted).toContain("someField");
    expect(formatted).toContain("value");
  });

  it("handles empty array", () => {
    const formatted = formatToolResults([]);
    expect(formatted).toEqual("");
  });

  it("handles string output directly", () => {
    const results = [
      {
        type: "tool-result" as const,
        toolCallId: "call-1",
        toolName: "text_tool",
        input: {},
        output: "plain text response",
      },
    ];

    const formatted = formatToolResults(results);

    expect(formatted).toContain("plain text response");
  });
});
