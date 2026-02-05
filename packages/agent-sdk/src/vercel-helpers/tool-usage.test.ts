import { describe, expect, test } from "vitest";
import type { ToolCall } from "../types.ts";
import { extractToolCallInput } from "./tool-usage.ts";

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
