import { pruneMessages } from "@atlas/llm";
import { logger } from "@atlas/logger";
import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { estimateTokens, truncateMessageHistory } from "./message-windowing.ts";

// Helper to create long strings for token weight
const makeString = (length: number) => "a".repeat(length);

describe("message-windowing", () => {
  it("estimateTokens - basic estimation", () => {
    expect(estimateTokens(null)).toEqual(0);
    expect(estimateTokens(undefined)).toEqual(0);
    // "test" -> JSON: "test" (6 chars) -> 2 tokens
    expect(estimateTokens("test")).toEqual(2);
    // {a:1} -> JSON: {"a":1} (7 chars) -> 2 tokens
    expect(estimateTokens({ a: 1 })).toEqual(2);
  });

  it("truncateMessageHistory - prioritizes system and new messages", () => {
    const messages: ModelMessage[] = [
      { role: "system", content: "System Prompt" },
      { role: "user", content: "Old Message 1" },
      { role: "assistant", content: "Old Message 2" },
      { role: "user", content: "New Message 1" },
      { role: "assistant", content: "New Message 2" },
    ];

    // Max tokens small enough to force truncation
    // Each message JSON is ~45 chars => ~12 tokens.
    // System (12) + Newest (12) + 2nd Newest (12) = 36 tokens.
    // Set limit to 30 to keep System + 1 Newest.
    // Set limit to 40 to keep System + 2 Newest.
    const config = { maxTokens: 40, minMessages: 0 };

    const result = truncateMessageHistory(messages, config, logger);

    // Should keep System and Newest
    // Result length should be 3
    expect(result.length).toEqual(3);
    expect(result.at(0)?.role).toEqual("system");
    expect(result.at(1)?.role).toEqual("user");
    expect(result.at(1)?.content).toEqual("New Message 1");
    expect(result[2]?.role).toEqual("assistant");
    expect(result[2]?.content).toEqual("New Message 2");
  });

  it("truncateMessageHistory - respects hard limit", () => {
    const bigContent = makeString(100);

    const messages: ModelMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: bigContent },
      { role: "user", content: bigContent },
    ];

    // Budget: enough for System + 1 Big Message (~45 tokens)
    const config = { maxTokens: 60, minMessages: 0 };

    const result = truncateMessageHistory(messages, config, logger);

    expect(result.length).toEqual(2);
    expect(result.at(0)?.role).toEqual("system");
    expect(result.at(1)?.role).toEqual("user");
    expect(result.at(1)?.content).toEqual(bigContent);
  });

  it("processMessageHistory (pipeline) - integration of pruning and truncation", () => {
    // Setup:
    // 1. System msg
    // 2. Old Tool Call (Should be pruned)
    // 3. New Tool Call (Should be kept)

    const modelMessages: ModelMessage[] = [
      { role: "system", content: "System" },
      // Old message with tool call
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call_1",
            toolName: "test",
            input: { huge: makeString(1000) },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call_1",
            toolName: "test",
            output: { type: "text", value: "Huge Result" },
          },
        ],
      },
      // Padding messages
      { role: "user", content: "pad 1" },
      { role: "assistant", content: "pad 2" },
      { role: "user", content: "pad 3" },
      { role: "assistant", content: "pad 4" },
    ];

    const config = { maxTokens: 1000, minMessages: 0 };

    // Manually replicate processMessageHistory pipeline
    // 1. Prune
    const prunedMessages = pruneMessages({
      messages: modelMessages,
      toolCalls: "before-last-4-messages",
      emptyMessages: "remove",
    });

    // 2. Truncate
    const result = truncateMessageHistory(prunedMessages, config, logger);

    // Check result
    // Msg 2 (Assistant Tool Call) should be gone because it was pruned to empty and removed
    // Msg 3 (Tool Result) should ALSO be gone because it was a result for a pruned call

    expect(result.length).toEqual(5);
    expect(result.at(0)?.role).toEqual("system");
    expect(result.at(1)?.role).toEqual("user");
    expect(result.at(1)?.content).toEqual("pad 1");
  });

  it("processMessageHistory (pipeline) - preserves recent tool calls", () => {
    const modelMessages: ModelMessage[] = [
      { role: "system", content: "System" },
      // Recent tool call (inside last 4)
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call_recent",
            toolName: "test",
            input: { data: "important" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call_recent",
            toolName: "test",
            output: { type: "text", value: "result" },
          },
        ],
      },
    ];

    const config = { maxTokens: 1000, minMessages: 0 };

    const prunedMessages = pruneMessages({
      messages: modelMessages,
      toolCalls: "before-last-4-messages",
      emptyMessages: "remove",
    });

    const result = truncateMessageHistory(prunedMessages, config, logger);

    // Should preserve both messages
    expect(result.length).toEqual(3);
    const toolMsg = result.at(1);

    // Check if tool content exists
    if (toolMsg && Array.isArray(toolMsg.content)) {
      const hasToolCall = toolMsg.content.some((p) => p.type === "tool-call");
      expect(hasToolCall).toEqual(true);
    } else {
      throw new Error("Expected content array for tool message");
    }
  });
});
