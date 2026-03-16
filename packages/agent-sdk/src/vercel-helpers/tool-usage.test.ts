import { describe, expect, test, vi } from "vitest";
import type { Logger, ToolCall, ToolResult } from "../types.ts";
import { extractArtifactRefsFromToolResults, extractToolCallInput } from "./tool-usage.ts";

describe("extractToolCallInput", () => {
  function makeToolCall(toolName: string, input: unknown): ToolCall {
    return { type: "tool-call", toolCallId: `call-${toolName}`, toolName, input } as ToolCall;
  }

  test("extracts tool input when tool exists with object input", () => {
    const toolCalls = [makeToolCall("complete", { ticket_id: "PROJ-123", priority: "high" })];

    const result = extractToolCallInput(toolCalls, "complete");

    expect(result).toEqual({ ticket_id: "PROJ-123", priority: "high" });
  });

  test("returns undefined when tool not found", () => {
    const toolCalls = [makeToolCall("other_tool", { foo: "bar" })];

    const result = extractToolCallInput(toolCalls, "complete");

    expect(result).toBeUndefined();
  });

  test("returns undefined when input is null", () => {
    const toolCalls = [makeToolCall("complete", null)];

    const result = extractToolCallInput(toolCalls, "complete");

    expect(result).toBeUndefined();
  });

  test("returns undefined when input is primitive string", () => {
    const toolCalls = [makeToolCall("complete", "just a string")];

    const result = extractToolCallInput(toolCalls, "complete");

    expect(result).toBeUndefined();
  });

  test("returns undefined when input is primitive number", () => {
    const toolCalls = [makeToolCall("complete", 42)];

    const result = extractToolCallInput(toolCalls, "complete");

    expect(result).toBeUndefined();
  });

  test("returns undefined for empty array", () => {
    const result = extractToolCallInput([], "complete");

    expect(result).toBeUndefined();
  });

  test("finds tool anywhere in array, not just first position", () => {
    const toolCalls = [
      makeToolCall("linear.get_issue", { issueId: "PROJ-123" }),
      makeToolCall("artifacts_read", { id: "doc-1" }),
      makeToolCall("complete", { found: true, position: "third" }),
    ];

    const result = extractToolCallInput(toolCalls, "complete");

    expect(result).toEqual({ found: true, position: "third" });
  });

  test("returns first matching tool if duplicates exist", () => {
    const toolCalls = [
      makeToolCall("complete", { attempt: 1 }),
      makeToolCall("complete", { attempt: 2 }),
    ];

    const result = extractToolCallInput(toolCalls, "complete");

    expect(result).toEqual({ attempt: 1 });
  });

  test("works with failStep tool (not just complete)", () => {
    const toolCalls = [
      makeToolCall("some_tool", {}),
      makeToolCall("failStep", { reason: "Cannot proceed" }),
    ];

    const result = extractToolCallInput(toolCalls, "failStep");

    expect(result).toEqual({ reason: "Cannot proceed" });
  });
});

describe("extractArtifactRefsFromToolResults", () => {
  function makeArtifactResult(artifact: { id: string; type: string; summary: string }): ToolResult {
    return {
      type: "tool-result",
      toolCallId: "call-1",
      toolName: "artifacts_create",
      output: { isError: false, content: [{ type: "text", text: JSON.stringify(artifact) }] },
    } as ToolResult;
  }

  test("extracts refs from successful artifacts_create results", () => {
    const results = [
      makeArtifactResult({ id: "art-1", type: "document", summary: "A doc" }),
      makeArtifactResult({ id: "art-2", type: "code", summary: "Some code" }),
    ];

    const refs = extractArtifactRefsFromToolResults(results);

    expect(refs).toEqual([
      { id: "art-1", type: "document", summary: "A doc" },
      { id: "art-2", type: "code", summary: "Some code" },
    ]);
  });

  test("skips error tool results", () => {
    const results: ToolResult[] = [
      {
        type: "tool-result",
        toolCallId: "call-1",
        toolName: "artifacts_create",
        output: { isError: true, content: [{ type: "text", text: "boom" }] },
      } as ToolResult,
    ];

    const refs = extractArtifactRefsFromToolResults(results);

    expect(refs).toEqual([]);
  });

  test("skips non-artifacts_create tool results", () => {
    const results: ToolResult[] = [
      {
        type: "tool-result",
        toolCallId: "call-1",
        toolName: "some_other_tool",
        output: { isError: false, content: [{ type: "text", text: "{}" }] },
      } as ToolResult,
    ];

    const refs = extractArtifactRefsFromToolResults(results);

    expect(refs).toEqual([]);
  });

  test("skips results with malformed JSON", () => {
    const results: ToolResult[] = [
      {
        type: "tool-result",
        toolCallId: "call-1",
        toolName: "artifacts_create",
        output: { isError: false, content: [{ type: "text", text: "not json" }] },
      } as ToolResult,
    ];

    const refs = extractArtifactRefsFromToolResults(results);

    expect(refs).toEqual([]);
  });

  test("skips results with missing required fields", () => {
    const results: ToolResult[] = [
      {
        type: "tool-result",
        toolCallId: "call-1",
        toolName: "artifacts_create",
        output: {
          isError: false,
          content: [{ type: "text", text: JSON.stringify({ id: "art-1" }) }],
        },
      } as ToolResult,
    ];

    const refs = extractArtifactRefsFromToolResults(results);

    expect(refs).toEqual([]);
  });

  test("works without logger (no throw)", () => {
    const results: ToolResult[] = [
      {
        type: "tool-result",
        toolCallId: "call-1",
        toolName: "artifacts_create",
        output: { isError: true, content: [{ type: "text", text: "err" }] },
      } as ToolResult,
      {
        type: "tool-result",
        toolCallId: "call-2",
        toolName: "artifacts_create",
        output: { isError: false, content: [{ type: "text", text: "bad json" }] },
      } as ToolResult,
    ];

    expect(() => extractArtifactRefsFromToolResults(results)).not.toThrow();
    expect(extractArtifactRefsFromToolResults(results)).toEqual([]);
  });

  test("logs debug messages when logger is provided", () => {
    const logger: Logger = {
      trace: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      fatal: vi.fn(),
      child: vi.fn(),
    };

    const results: ToolResult[] = [
      {
        type: "tool-result",
        toolCallId: "call-1",
        toolName: "artifacts_create",
        output: { isError: true, content: [{ type: "text", text: "err" }] },
      } as ToolResult,
    ];

    extractArtifactRefsFromToolResults(results, logger);

    expect(logger.debug).toHaveBeenCalledWith("skipping error tool result", expect.any(Object));
  });
});
