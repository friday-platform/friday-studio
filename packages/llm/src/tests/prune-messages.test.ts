import { assertEquals } from "@std/assert";
import type { ModelMessage } from "ai";
import { pruneMessages } from "../prune-messages.ts";

const messagesFixture1: ModelMessage[] = [
  { role: "user", content: [{ type: "text", text: "Weather in Tokyo and Busan?" }] },
  {
    role: "assistant",
    content: [
      { type: "reasoning", text: "I need to get the weather in Tokyo and Busan." },
      {
        type: "tool-call",
        toolCallId: "call-1",
        toolName: "get-weather-tool-1",
        input: '{"city": "Tokyo"}',
      },
      {
        type: "tool-call",
        toolCallId: "call-2",
        toolName: "get-weather-tool-2",
        input: '{"city": "Busan"}',
      },
    ],
  },
  {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: "call-1",
        toolName: "get-weather-tool-1",
        output: { type: "text", value: "sunny" },
      },
      {
        type: "tool-result",
        toolCallId: "call-2",
        toolName: "get-weather-tool-2",
        output: { type: "error-text", value: "Error: Fetching weather data failed" },
      },
    ],
  },
  {
    role: "assistant",
    content: [
      { type: "reasoning", text: "I have got the weather in Tokyo and Busan." },
      {
        type: "text",
        text: "The weather in Tokyo is sunny. I could not get the weather in Busan.",
      },
    ],
  },
];

const messagesFixture2: ModelMessage[] = [
  { role: "user", content: [{ type: "text", text: "Weather in Tokyo and Busan?" }] },
  {
    role: "assistant",
    content: [
      { type: "reasoning", text: "I need to get the weather in Tokyo and Busan." },
      {
        type: "tool-call",
        toolCallId: "call-1",
        toolName: "get-weather-tool-1",
        input: '{"city": "Tokyo"}',
      },
      {
        type: "tool-call",
        toolCallId: "call-2",
        toolName: "get-weather-tool-2",
        input: '{"city": "Busan"}',
      },
    ],
  },
];

Deno.test("pruneMessages - reasoning - all", () => {
  const result = pruneMessages({ messages: messagesFixture1, reasoning: "all" });

  assertEquals(result, [
    { content: [{ text: "Weather in Tokyo and Busan?", type: "text" }], role: "user" },
    {
      content: [
        {
          input: '{"city": "Tokyo"}',
          toolCallId: "call-1",
          toolName: "get-weather-tool-1",
          type: "tool-call",
        },
        {
          input: '{"city": "Busan"}',
          toolCallId: "call-2",
          toolName: "get-weather-tool-2",
          type: "tool-call",
        },
      ],
      role: "assistant",
    },
    {
      content: [
        {
          output: { type: "text", value: "sunny" },
          toolCallId: "call-1",
          toolName: "get-weather-tool-1",
          type: "tool-result",
        },
        {
          output: { type: "error-text", value: "Error: Fetching weather data failed" },
          toolCallId: "call-2",
          toolName: "get-weather-tool-2",
          type: "tool-result",
        },
      ],
      role: "tool",
    },
    {
      content: [
        {
          text: "The weather in Tokyo is sunny. I could not get the weather in Busan.",
          type: "text",
        },
      ],
      role: "assistant",
    },
  ]);
});

Deno.test("pruneMessages - reasoning - before-trailing-message", () => {
  const result = pruneMessages({ messages: messagesFixture1, reasoning: "before-last-message" });

  assertEquals(result, [
    { content: [{ text: "Weather in Tokyo and Busan?", type: "text" }], role: "user" },
    {
      content: [
        {
          input: '{"city": "Tokyo"}',
          toolCallId: "call-1",
          toolName: "get-weather-tool-1",
          type: "tool-call",
        },
        {
          input: '{"city": "Busan"}',
          toolCallId: "call-2",
          toolName: "get-weather-tool-2",
          type: "tool-call",
        },
      ],
      role: "assistant",
    },
    {
      content: [
        {
          output: { type: "text", value: "sunny" },
          toolCallId: "call-1",
          toolName: "get-weather-tool-1",
          type: "tool-result",
        },
        {
          output: { type: "error-text", value: "Error: Fetching weather data failed" },
          toolCallId: "call-2",
          toolName: "get-weather-tool-2",
          type: "tool-result",
        },
      ],
      role: "tool",
    },
    {
      content: [
        { text: "I have got the weather in Tokyo and Busan.", type: "reasoning" },
        {
          text: "The weather in Tokyo is sunny. I could not get the weather in Busan.",
          type: "text",
        },
      ],
      role: "assistant",
    },
  ]);
});

Deno.test("pruneMessages - toolCalls - all", () => {
  const result = pruneMessages({ messages: messagesFixture1, toolCalls: "all" });

  assertEquals(result, [
    { content: [{ text: "Weather in Tokyo and Busan?", type: "text" }], role: "user" },
    {
      content: [{ text: "I need to get the weather in Tokyo and Busan.", type: "reasoning" }],
      role: "assistant",
    },
    {
      content: [
        { text: "I have got the weather in Tokyo and Busan.", type: "reasoning" },
        {
          text: "The weather in Tokyo is sunny. I could not get the weather in Busan.",
          type: "text",
        },
      ],
      role: "assistant",
    },
  ]);
});

Deno.test("pruneMessages - toolCalls - before-last-message", () => {
  const result = pruneMessages({ messages: messagesFixture2, toolCalls: "before-last-message" });

  assertEquals(result, [
    { content: [{ text: "Weather in Tokyo and Busan?", type: "text" }], role: "user" },
    {
      content: [
        { text: "I need to get the weather in Tokyo and Busan.", type: "reasoning" },
        {
          input: '{"city": "Tokyo"}',
          toolCallId: "call-1",
          toolName: "get-weather-tool-1",
          type: "tool-call",
        },
        {
          input: '{"city": "Busan"}',
          toolCallId: "call-2",
          toolName: "get-weather-tool-2",
          type: "tool-call",
        },
      ],
      role: "assistant",
    },
  ]);
});

Deno.test("pruneMessages - toolCalls - before-last-2-messages", () => {
  const result = pruneMessages({ messages: messagesFixture1, toolCalls: "before-last-2-messages" });

  assertEquals(result, [
    { content: [{ text: "Weather in Tokyo and Busan?", type: "text" }], role: "user" },
    {
      content: [
        { text: "I need to get the weather in Tokyo and Busan.", type: "reasoning" },
        {
          input: '{"city": "Tokyo"}',
          toolCallId: "call-1",
          toolName: "get-weather-tool-1",
          type: "tool-call",
        },
        {
          input: '{"city": "Busan"}',
          toolCallId: "call-2",
          toolName: "get-weather-tool-2",
          type: "tool-call",
        },
      ],
      role: "assistant",
    },
    {
      content: [
        {
          output: { type: "text", value: "sunny" },
          toolCallId: "call-1",
          toolName: "get-weather-tool-1",
          type: "tool-result",
        },
        {
          output: { type: "error-text", value: "Error: Fetching weather data failed" },
          toolCallId: "call-2",
          toolName: "get-weather-tool-2",
          type: "tool-result",
        },
      ],
      role: "tool",
    },
    {
      content: [
        { text: "I have got the weather in Tokyo and Busan.", type: "reasoning" },
        {
          text: "The weather in Tokyo is sunny. I could not get the weather in Busan.",
          type: "text",
        },
      ],
      role: "assistant",
    },
  ]);
});

Deno.test("pruneMessages - two tool settings", () => {
  const result = pruneMessages({
    messages: messagesFixture1,
    toolCalls: [
      { type: "all", tools: ["get-weather-tool-1"] },
      { type: "before-last-2-messages", tools: ["get-weather-tool-2"] },
    ],
  });

  assertEquals(result, [
    { content: [{ text: "Weather in Tokyo and Busan?", type: "text" }], role: "user" },
    {
      content: [
        { text: "I need to get the weather in Tokyo and Busan.", type: "reasoning" },
        {
          input: '{"city": "Busan"}',
          toolCallId: "call-2",
          toolName: "get-weather-tool-2",
          type: "tool-call",
        },
      ],
      role: "assistant",
    },
    {
      content: [
        {
          output: { type: "error-text", value: "Error: Fetching weather data failed" },
          toolCallId: "call-2",
          toolName: "get-weather-tool-2",
          type: "tool-result",
        },
      ],
      role: "tool",
    },
    {
      content: [
        { text: "I have got the weather in Tokyo and Busan.", type: "reasoning" },
        {
          text: "The weather in Tokyo is sunny. I could not get the weather in Busan.",
          type: "text",
        },
      ],
      role: "assistant",
    },
  ]);
});

// --- BUG REPRODUCTION TEST CASE ---

Deno.test("pruneMessages - bug reproduction: completed tool call before last message should be pruned", () => {
  const messages: ModelMessage[] = [
    {
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: "call_1", input: {}, toolName: "test" }],
    },
    {
      role: "tool",
      content: [
        {
          toolName: "Test Tool",
          type: "tool-result",
          toolCallId: "call_1",
          output: { type: "text", value: "Tool Result" },
        },
      ],
    },
    { role: "assistant", content: [{ type: "text", text: "Hello" }] },
  ];

  const result = pruneMessages({
    messages,
    toolCalls: "before-last-message",
    emptyMessages: "remove",
  });

  assertEquals(result, [{ role: "assistant", content: [{ type: "text", text: "Hello" }] }]);
});
