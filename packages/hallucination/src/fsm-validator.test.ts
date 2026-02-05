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
});
