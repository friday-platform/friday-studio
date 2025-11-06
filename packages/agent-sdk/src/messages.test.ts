import { assertEquals, assertRejects } from "@std/assert";
import { validateAtlasUIMessages } from "./messages.ts";

Deno.test("validateAtlasUIMessages - validates basic text message", async () => {
  const messages = [
    { id: "1", role: "user", parts: [{ type: "text", text: "Hello" }], metadata: {} },
  ];

  const validated = await validateAtlasUIMessages(messages);
  assertEquals(validated.length, 1);
  assertEquals(validated[0]?.role, "user");
});

Deno.test("validateAtlasUIMessages - validates message with metadata", async () => {
  const messages = [
    {
      id: "1",
      role: "assistant",
      parts: [{ type: "text", text: "Response" }],
      metadata: { agentId: "test-agent", sessionId: "test-session" },
    },
  ];

  const validated = await validateAtlasUIMessages(messages);
  assertEquals(validated.length, 1);
  assertEquals(validated[0]?.metadata?.agentId, "test-agent");
  assertEquals(validated[0]?.metadata?.sessionId, "test-session");
});

Deno.test("validateAtlasUIMessages - validates session-start data event", async () => {
  const messages = [
    {
      id: "1",
      role: "assistant",
      parts: [
        {
          type: "data-session-start",
          data: { sessionId: "sess-123", signalId: "sig-456", workspaceId: "ws-789" },
        },
      ],
      metadata: {},
    },
  ];

  const validated = await validateAtlasUIMessages(messages);
  assertEquals(validated.length, 1);
  const dataPart = validated[0]?.parts[0];
  assertEquals(dataPart?.type, "data-session-start");
  if (dataPart?.type === "data-session-start") {
    assertEquals(dataPart.data.sessionId, "sess-123");
  }
});

Deno.test("validateAtlasUIMessages - validates session-finish data event", async () => {
  const messages = [
    {
      id: "1",
      role: "assistant",
      parts: [
        {
          type: "data-session-finish",
          data: {
            sessionId: "sess-123",
            workspaceId: "ws-789",
            status: "completed",
            duration: 5000,
            source: "user-input",
          },
        },
      ],
      metadata: {},
    },
  ];

  const validated = await validateAtlasUIMessages(messages);
  assertEquals(validated.length, 1);
  const dataPart = validated[0]?.parts[0];
  assertEquals(dataPart?.type, "data-session-finish");
  if (dataPart?.type === "data-session-finish") {
    assertEquals(dataPart.data.status, "completed");
    assertEquals(dataPart.data.duration, 5000);
  }
});

Deno.test("validateAtlasUIMessages - validates agent-error data event", async () => {
  const messages = [
    {
      id: "1",
      role: "assistant",
      parts: [
        {
          type: "data-agent-error",
          data: { agentId: "agent-123", duration: 1500, error: "Timeout occurred" },
        },
      ],
      metadata: {},
    },
  ];

  const validated = await validateAtlasUIMessages(messages);
  assertEquals(validated.length, 1);
  const dataPart = validated[0]?.parts[0];
  assertEquals(dataPart?.type, "data-agent-error");
  if (dataPart?.type === "data-agent-error") {
    assertEquals(dataPart.data.error, "Timeout occurred");
  }
});

Deno.test("validateAtlasUIMessages - validates user-message data event", async () => {
  const messages = [
    {
      id: "1",
      role: "assistant",
      parts: [{ type: "data-user-message", data: { content: "User sent this message" } }],
      metadata: {},
    },
  ];

  const validated = await validateAtlasUIMessages(messages);
  assertEquals(validated.length, 1);
  const dataPart = validated[0]?.parts[0];
  assertEquals(dataPart?.type, "data-user-message");
  if (dataPart?.type === "data-user-message") {
    assertEquals(dataPart.data.content, "User sent this message");
  }
});

Deno.test("validateAtlasUIMessages - validates tool-progress data event", async () => {
  const messages = [
    {
      id: "1",
      role: "assistant",
      parts: [
        {
          type: "data-tool-progress",
          data: { toolName: "search", content: "Searching for documents..." },
        },
      ],
      metadata: {},
    },
  ];

  const validated = await validateAtlasUIMessages(messages);
  assertEquals(validated.length, 1);
  const dataPart = validated[0]?.parts[0];
  assertEquals(dataPart?.type, "data-tool-progress");
  if (dataPart?.type === "data-tool-progress") {
    assertEquals(dataPart.data.toolName, "search");
  }
});

Deno.test("validateAtlasUIMessages - rejects invalid session-start (missing fields)", async () => {
  const messages = [
    {
      id: "1",
      role: "assistant",
      parts: [
        {
          type: "data-session-start",
          data: {
            sessionId: "sess-123",
            // Missing signalId and workspaceId
          },
        },
      ],
    },
  ];

  await assertRejects(async () => await validateAtlasUIMessages(messages), Error);
});

Deno.test("validateAtlasUIMessages - rejects invalid metadata", async () => {
  const messages = [
    {
      id: "1",
      role: "assistant",
      parts: [{ type: "text", text: "Hello" }],
      metadata: {
        agentId: 123, // Should be string
      },
    },
  ];

  await assertRejects(async () => await validateAtlasUIMessages(messages), Error);
});

Deno.test("validateAtlasUIMessages - validates multiple messages", async () => {
  const messages = [
    { id: "1", role: "user", parts: [{ type: "text", text: "First message" }], metadata: {} },
    {
      id: "2",
      role: "assistant",
      parts: [{ type: "data-agent-start", data: { agentId: "agent-1", task: "Process request" } }],
      metadata: {},
    },
    {
      id: "3",
      role: "assistant",
      parts: [{ type: "text", text: "Response message" }],
      metadata: {},
    },
  ];

  const validated = await validateAtlasUIMessages(messages);
  assertEquals(validated.length, 3);
  assertEquals(validated[0]?.role, "user");
  assertEquals(validated[1]?.role, "assistant");
  assertEquals(validated[2]?.role, "assistant");
});

Deno.test("validateAtlasUIMessages - validates message with multiple parts", async () => {
  const messages = [
    {
      id: "1",
      role: "assistant",
      parts: [
        { type: "text", text: "Starting task..." },
        { type: "data-agent-start", data: { agentId: "agent-1", task: "Execute workflow" } },
        { type: "text", text: "Task started" },
      ],
      metadata: {},
    },
  ];

  const validated = await validateAtlasUIMessages(messages);
  assertEquals(validated.length, 1);
  assertEquals(validated[0]?.parts.length, 3);
});
