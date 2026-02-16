import type { AtlasUIMessage } from "@atlas/agent-sdk";
import { pruneMessages } from "@atlas/llm";
import { logger } from "@atlas/logger";
import type { ImagePart, ModelMessage } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  estimateTokens,
  processMessageHistory,
  truncateMessageHistory,
} from "./message-windowing.ts";

const { mockGetManyLatest, mockResolveImageParts } = vi.hoisted(() => ({
  mockGetManyLatest: vi.fn(),
  mockResolveImageParts: vi.fn(),
}));

vi.mock("@atlas/core/artifacts/storage", () => ({
  ArtifactStorage: { getManyLatest: mockGetManyLatest },
}));

vi.mock("@atlas/core/artifacts/images", () => ({ resolveImageParts: mockResolveImageParts }));

// Helper to create long strings for token weight
const makeString = (length: number) => "a".repeat(length);

describe("message-windowing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

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

  it("processMessageHistory - injects ImageParts for image artifacts", async () => {
    const messages: AtlasUIMessage[] = [
      {
        id: "msg-1",
        role: "user" as const,
        parts: [
          { type: "text" as const, text: "Look at this photo" },
          {
            type: "data-artifact-attached" as const,
            data: { artifactIds: ["img-1"], filenames: ["photo.png"], mimeTypes: ["image/png"] },
          },
        ],
      },
    ];

    const fakeImagePart: ImagePart = {
      type: "image",
      image: new Uint8Array([1, 2, 3]),
      mediaType: "image/png",
    };

    mockGetManyLatest.mockResolvedValue({
      ok: true,
      data: [
        {
          id: "img-1",
          data: { type: "file", data: { mimeType: "image/png", originalName: "photo.png" } },
        },
      ],
    });
    mockResolveImageParts.mockResolvedValue([fakeImagePart]);

    const result = await processMessageHistory(messages, { maxTokens: 10000 }, logger);

    // Last user message should contain the injected ImagePart
    const lastUser = result.findLast((m) => m.role === "user");
    if (!lastUser || !Array.isArray(lastUser.content)) {
      throw new Error("Expected user message with array content");
    }

    const hasImage = lastUser.content.some((p) => p.type === "image");
    expect(hasImage).toBe(true);

    expect(mockGetManyLatest).toHaveBeenCalledWith({ ids: ["img-1"] });
    expect(mockResolveImageParts).toHaveBeenCalled();
  });

  it("processMessageHistory - skips injection for non-image artifacts", async () => {
    const messages: AtlasUIMessage[] = [
      {
        id: "msg-1",
        role: "user" as const,
        parts: [
          { type: "text" as const, text: "Here is a spreadsheet" },
          {
            type: "data-artifact-attached" as const,
            data: { artifactIds: ["csv-1"], filenames: ["data.csv"], mimeTypes: ["text/csv"] },
          },
        ],
      },
    ];

    const result = await processMessageHistory(messages, { maxTokens: 10000 }, logger);

    // Non-image artifacts should not trigger storage fetch
    expect(mockGetManyLatest).not.toHaveBeenCalled();

    // Result should still contain the user message with text content
    const lastUser = result.findLast((m) => m.role === "user");
    expect(lastUser).toBeDefined();
  });

  it("estimateTokens - assigns ~1600 tokens per ImagePart instead of serializing binary", () => {
    const bigImage = new Uint8Array(1_000_000); // 1MB
    const messageWithImage = {
      role: "user",
      content: [
        { type: "text", text: "describe this" },
        { type: "image", image: bigImage, mediaType: "image/png" },
      ],
    };

    const tokens = estimateTokens(messageWithImage);

    // Should be ~1600 for the image + small overhead for text + role, NOT millions
    expect(tokens).toBeLessThan(2000);
    expect(tokens).toBeGreaterThanOrEqual(1600);
  });

  /**
   * Regression test for chat_kBcv9mRgs2mXSRtW "swallowed messages" bug.
   *
   * Scenario: Anthropic API returns finishReason="content-filter" after tool
   * calls, producing an assistant message with only step-start parts (no text).
   * This message is stored to chat history. On subsequent user messages:
   *
   * 1. convertToModelMessages: step-start-only assistant → 0 model messages
   * 2. pruneMessages(emptyMessages:"remove"): removes truly empty messages
   * 3. Result: consecutive user messages (violates alternating role requirement)
   *
   * The Anthropic API rejects or produces empty responses for consecutive
   * user messages, causing every subsequent message to also fail (cascade).
   *
   * The fix merges consecutive user messages after pruning so the API always
   * sees properly alternating user/assistant roles.
   */
  it("regression: content-filter step-start-only assistant must not create consecutive user messages", async () => {
    // Reproduce the exact message structure from the production bug.
    // Messages 0-3: normal conversation
    // Message 4 (user): attaches PDFs, asks to fill SOW
    // Message 5 (assistant): tool calls succeed, but step 2 returns content-filter → only step-start parts stored
    // Message 6 (user): "?" retry
    // Message 7 (assistant): another content-filter → step-start only
    // Message 8 (user): "hello?" retry
    const messages = [
      {
        id: "msg-0",
        role: "user" as const,
        parts: [{ type: "text" as const, text: "Help me draft a SOW" }],
        createdAt: new Date(),
      },
      {
        id: "msg-1",
        role: "assistant" as const,
        parts: [
          { type: "step-start" as const },
          { type: "text" as const, text: "Here's what a SOW typically includes..." },
        ],
        createdAt: new Date(),
      },
      {
        id: "msg-2",
        role: "user" as const,
        parts: [{ type: "text" as const, text: "Here are the contracts, fill it in" }],
        createdAt: new Date(),
      },
      {
        // content-filter: tool calls completed (step 1) but text generation blocked (step 2)
        // Only step-start parts remain — no text, no tool parts in UI message
        id: "msg-3",
        role: "assistant" as const,
        parts: [{ type: "step-start" as const }],
        createdAt: new Date(),
      },
      {
        id: "msg-4",
        role: "user" as const,
        parts: [{ type: "text" as const, text: "?" }],
        createdAt: new Date(),
      },
      {
        // second content-filter: step-start only again
        id: "msg-5",
        role: "assistant" as const,
        parts: [{ type: "step-start" as const }],
        createdAt: new Date(),
      },
      {
        id: "msg-6",
        role: "user" as const,
        parts: [{ type: "text" as const, text: "hello?" }],
        createdAt: new Date(),
      },
    ];

    const config = { maxTokens: 100000 };
    const result = await processMessageHistory(messages, config, logger);

    // CRITICAL ASSERTION: no consecutive user messages in the output.
    // Without the fix, msg-3 and msg-5 (step-start-only assistants) produce
    // zero model messages, leaving msg-2/msg-4/msg-6 as three consecutive
    // user messages → API rejection → empty responses → "swallowed" messages.
    for (let i = 1; i < result.length; i++) {
      const curr = result[i];
      const prev = result[i - 1];
      if (curr && prev && curr.role === "user" && prev.role === "user") {
        throw new Error(
          `Consecutive user messages at indices ${i - 1} and ${i}: ` +
            `"${JSON.stringify(prev.content).slice(0, 60)}" → "${JSON.stringify(curr.content).slice(0, 60)}"`,
        );
      }
    }

    // The three user messages (msg-2, msg-4, msg-6) that were separated by
    // empty assistants should now be merged into a single user message.
    const userMessages = result.filter((m) => m.role === "user");
    expect(userMessages).toHaveLength(2); // msg-0 stays separate, msg-2+4+6 merged

    // Verify merged message contains all three user texts
    const mergedUser = userMessages[1];
    expect(mergedUser).toBeDefined();
    if (Array.isArray(mergedUser?.content)) {
      const texts = mergedUser.content
        .filter((p): p is { type: "text"; text: string } => p.type === "text")
        .map((p) => p.text);
      expect(texts).toContain("Here are the contracts, fill it in");
      expect(texts).toContain("?");
      expect(texts).toContain("hello?");
    }
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
