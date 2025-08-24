import type { SSEEvent } from "@atlas/config";
import { assertEquals, assertExists } from "@std/assert";
import { formatMessage, getGroupedMessages } from "./utils.ts";

Deno.test("formatMessage - returns undefined for empty messages array", () => {
  const result = formatMessage([]);
  assertEquals(result, undefined);
});

Deno.test("formatMessage - formats text message correctly", () => {
  const messages: SSEEvent[] = [
    {
      id: "msg-1",
      type: "text",
      timestamp: "2024-01-01T12:00:00Z",
      data: { content: "Hello from Atlas" },
    },
  ];

  const result = formatMessage(messages);
  assertExists(result);
  assertEquals(result.id, "msg-1");
  assertEquals(result.type, "text");
  assertEquals(result.author, "Atlas");
  assertEquals(result.content, "Hello from Atlas");
  assertEquals(result.timestamp, "2024-01-01T12:00:00Z");
});

Deno.test("formatMessage - formats request message with current user", () => {
  const originalUser = Deno.env.get("USER");
  Deno.env.set("USER", "TestUser");

  const messages: SSEEvent[] = [
    {
      id: "req-1",
      type: "request",
      timestamp: "2024-01-01T12:00:00Z",
      data: { content: "User request" },
    },
  ];

  const result = formatMessage(messages);
  assertExists(result);
  assertEquals(result.id, "req-1");
  assertEquals(result.type, "request");
  assertEquals(result.author, "TestUser");
  assertEquals(result.content, "User request");

  // Restore original USER env
  if (originalUser) {
    Deno.env.set("USER", originalUser);
  } else {
    Deno.env.delete("USER");
  }
});

Deno.test("formatMessage - concatenates multiple message parts", () => {
  const messages: SSEEvent[] = [
    { id: "msg-1", type: "text", timestamp: "2024-01-01T12:00:00Z", data: { content: "Part 1" } },
    { id: "msg-1", type: "text", timestamp: "2024-01-01T12:00:01Z", data: { content: " Part 2" } },
    { id: "msg-1", type: "text", timestamp: "2024-01-01T12:00:02Z", data: { content: " Part 3" } },
  ];

  const result = formatMessage(messages);
  assertExists(result);
  assertEquals(result.content, "Part 1 Part 2 Part 3");
});

Deno.test("formatMessage - handles thinking type messages", () => {
  const messages: SSEEvent[] = [
    {
      id: "think-1",
      type: "thinking",
      timestamp: "2024-01-01T12:00:00Z",
      data: { content: "Processing..." },
    },
  ];

  const result = formatMessage(messages);
  assertExists(result);
  assertEquals(result.type, "thinking");
  assertEquals(result.content, "Processing...");
});

Deno.test("formatMessage - handles tool_call type messages", () => {
  const messages: SSEEvent[] = [
    {
      id: "tool-1",
      type: "tool_call",
      timestamp: "2024-01-01T12:00:00Z",
      data: { content: "Calling API..." },
    },
  ];

  const result = formatMessage(messages);
  assertExists(result);
  assertEquals(result.type, "tool_call");
  assertEquals(result.content, "Calling API...");
});

Deno.test("formatMessage - handles error type messages", () => {
  const messages: SSEEvent[] = [
    {
      id: "err-1",
      type: "error",
      timestamp: "2024-01-01T12:00:00Z",
      data: { content: "An error occurred" },
    },
  ];

  const result = formatMessage(messages);
  assertExists(result);
  assertEquals(result.type, "error");
  assertEquals(result.content, "An error occurred");
});

Deno.test("getGroupedMessages - returns empty object for empty array", () => {
  const result = getGroupedMessages([]);
  assertEquals(result, {});
});

Deno.test("getGroupedMessages - groups messages by id", () => {
  const messages: SSEEvent[] = [
    {
      id: "msg-1",
      type: "text",
      timestamp: "2024-01-01T12:00:00Z",
      data: { content: "Message 1 Part 1" },
    },
    {
      id: "msg-2",
      type: "text",
      timestamp: "2024-01-01T12:00:01Z",
      data: { content: "Message 2" },
    },
    {
      id: "msg-1",
      type: "text",
      timestamp: "2024-01-01T12:00:02Z",
      data: { content: "Message 1 Part 2" },
    },
  ];

  const result = getGroupedMessages(messages);

  assertEquals(Object.keys(result).length, 2);
  assertEquals(result["msg-1"].length, 2);
  assertEquals(result["msg-2"].length, 1);
  assertEquals(result["msg-1"][0].data.content, "Message 1 Part 1");
  assertEquals(result["msg-1"][1].data.content, "Message 1 Part 2");
  assertEquals(result["msg-2"][0].data.content, "Message 2");
});

Deno.test("getGroupedMessages - maintains message order within groups", () => {
  const messages: SSEEvent[] = [
    { id: "msg-1", type: "text", timestamp: "2024-01-01T12:00:00Z", data: { content: "First" } },
    { id: "msg-1", type: "text", timestamp: "2024-01-01T12:00:01Z", data: { content: "Second" } },
    { id: "msg-1", type: "text", timestamp: "2024-01-01T12:00:02Z", data: { content: "Third" } },
  ];

  const result = getGroupedMessages(messages);

  assertEquals(result["msg-1"][0].data.content, "First");
  assertEquals(result["msg-1"][1].data.content, "Second");
  assertEquals(result["msg-1"][2].data.content, "Third");
});

Deno.test("getGroupedMessages - handles different message types", () => {
  const messages: SSEEvent[] = [
    {
      id: "req-1",
      type: "request",
      timestamp: "2024-01-01T12:00:00Z",
      data: { content: "Request" },
    },
    {
      id: "text-1",
      type: "text",
      timestamp: "2024-01-01T12:00:01Z",
      data: { content: "Response" },
    },
    {
      id: "think-1",
      type: "thinking",
      timestamp: "2024-01-01T12:00:02Z",
      data: { content: "Thinking" },
    },
  ];

  const result = getGroupedMessages(messages);

  assertEquals(Object.keys(result).length, 3);
  assertEquals(result["req-1"][0].type, "request");
  assertEquals(result["text-1"][0].type, "text");
  assertEquals(result["think-1"][0].type, "thinking");
});
