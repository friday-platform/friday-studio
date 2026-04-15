import { describe, expect, it } from "vitest";
import { validateAtlasUIMessages } from "./messages.ts";

describe("validateAtlasUIMessages", () => {
  it("validates basic text message", async () => {
    const messages = [
      { id: "1", role: "user", parts: [{ type: "text", text: "Hello" }], metadata: {} },
    ];

    const validated = await validateAtlasUIMessages(messages);
    expect(validated.length).toEqual(1);
    expect(validated[0]?.role).toEqual("user");
  });

  it("validates message with metadata", async () => {
    const messages = [
      {
        id: "1",
        role: "assistant",
        parts: [{ type: "text", text: "Response" }],
        metadata: { agentId: "test-agent", sessionId: "test-session" },
      },
    ];

    const validated = await validateAtlasUIMessages(messages);
    expect(validated.length).toEqual(1);
    expect(validated[0]?.metadata?.agentId).toEqual("test-agent");
    expect(validated[0]?.metadata?.sessionId).toEqual("test-session");
  });

  it("validates session-start data event", async () => {
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
    expect(validated.length).toEqual(1);
    const dataPart = validated[0]?.parts[0];
    expect(dataPart?.type).toEqual("data-session-start");
    if (dataPart?.type === "data-session-start") {
      expect(dataPart.data.sessionId).toEqual("sess-123");
    }
  });

  it("validates session-finish data event", async () => {
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
    expect(validated.length).toEqual(1);
    const dataPart = validated[0]?.parts[0];
    expect(dataPart?.type).toEqual("data-session-finish");
    if (dataPart?.type === "data-session-finish") {
      expect(dataPart.data.status).toEqual("completed");
      expect(dataPart.data.duration).toEqual(5000);
    }
  });

  it("validates agent-error data event", async () => {
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
    expect(validated.length).toEqual(1);
    const dataPart = validated[0]?.parts[0];
    expect(dataPart?.type).toEqual("data-agent-error");
    if (dataPart?.type === "data-agent-error") {
      expect(dataPart.data.error).toEqual("Timeout occurred");
    }
  });

  it("validates user-message data event", async () => {
    const messages = [
      {
        id: "1",
        role: "assistant",
        parts: [{ type: "data-user-message", data: { content: "User sent this message" } }],
        metadata: {},
      },
    ];

    const validated = await validateAtlasUIMessages(messages);
    expect(validated.length).toEqual(1);
    const dataPart = validated[0]?.parts[0];
    expect(dataPart?.type).toEqual("data-user-message");
    if (dataPart?.type === "data-user-message") {
      expect(dataPart.data.content).toEqual("User sent this message");
    }
  });

  it("validates tool-progress data event", async () => {
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
    expect(validated.length).toEqual(1);
    const dataPart = validated[0]?.parts[0];
    expect(dataPart?.type).toEqual("data-tool-progress");
    if (dataPart?.type === "data-tool-progress") {
      expect(dataPart.data.toolName).toEqual("search");
    }
  });

  it("accepts session-start with only sessionId", async () => {
    const messages = [
      {
        id: "1",
        role: "assistant",
        parts: [{ type: "data-session-start", data: { sessionId: "sess-123" } }],
      },
    ];

    const validated = await validateAtlasUIMessages(messages);
    expect(validated.length).toEqual(1);
    const dataPart = validated[0]?.parts[0];
    expect(dataPart?.type).toEqual("data-session-start");
    if (dataPart?.type === "data-session-start") {
      expect(dataPart.data.sessionId).toEqual("sess-123");
    }
  });

  it("rejects invalid metadata", async () => {
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

    await expect(async () => await validateAtlasUIMessages(messages)).rejects.toThrow();
  });

  it("validates multiple messages", async () => {
    const messages = [
      { id: "1", role: "user", parts: [{ type: "text", text: "First message" }], metadata: {} },
      {
        id: "2",
        role: "assistant",
        parts: [
          { type: "data-agent-start", data: { agentId: "agent-1", task: "Process request" } },
        ],
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
    expect(validated.length).toEqual(3);
    expect(validated[0]?.role).toEqual("user");
    expect(validated[1]?.role).toEqual("assistant");
    expect(validated[2]?.role).toEqual("assistant");
  });

  it("validates message with multiple parts", async () => {
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
    expect(validated.length).toEqual(1);
    expect(validated[0]?.parts.length).toEqual(3);
  });

  it("accepts a plain string and wraps it as user UIMessage with text part", async () => {
    // Simulates: validateAtlasUIMessages(["hello"]) — what happens when
    // a caller sends `{ message: "hello" }` and the handler does [message]
    const validated = await validateAtlasUIMessages(["hello"]);
    expect(validated).toHaveLength(1);
    expect(validated[0]?.role).toEqual("user");
    expect(validated[0]?.parts[0]?.type).toEqual("text");
    if (validated[0]?.parts[0]?.type === "text") {
      expect(validated[0].parts[0].text).toEqual("hello");
    }
  });

  it("accepts an already-valid UIMessage object and passes it through", async () => {
    const msg = { id: "msg-1", role: "user", parts: [{ type: "text", text: "hi" }] };
    const validated = await validateAtlasUIMessages([msg]);
    expect(validated).toHaveLength(1);
    expect(validated[0]?.role).toEqual("user");
  });

  it("accepts an array containing a mix of strings and UIMessage objects", async () => {
    const validated = await validateAtlasUIMessages([
      "hello from string",
      { id: "msg-2", role: "user", parts: [{ type: "text", text: "hi from object" }] },
    ]);
    expect(validated).toHaveLength(2);
    expect(validated[0]?.role).toEqual("user");
    expect(validated[1]?.role).toEqual("user");
  });

  it("auto-assigns id to messages missing one", async () => {
    const messages = [{ role: "user", parts: [{ type: "text", text: "Hello" }] }];

    const validated = await validateAtlasUIMessages(messages);
    expect(validated.length).toEqual(1);
    expect(validated[0]?.role).toEqual("user");
    expect(typeof validated[0]?.id).toEqual("string");
    expect(validated[0]?.id.length).toBeGreaterThan(0);
  });

  it("replaces empty-string id with generated UUID", async () => {
    const messages = [{ id: "", role: "user", parts: [{ type: "text", text: "Hello" }] }];

    const validated = await validateAtlasUIMessages(messages);
    expect(validated.length).toEqual(1);
    expect(validated[0]?.id.length).toBeGreaterThan(0);
  });

  it("preserves existing id when message already has one", async () => {
    const messages = [
      { id: "existing-id-123", role: "user", parts: [{ type: "text", text: "Hello" }] },
    ];

    const validated = await validateAtlasUIMessages(messages);
    expect(validated.length).toEqual(1);
    expect(validated[0]?.id).toEqual("existing-id-123");
  });

  it("strings always become role:user — no way to forge other roles", async () => {
    // Plain strings are always normalized to role: "user", ensuring
    // no prompt injection via string-based messages
    const validated = await validateAtlasUIMessages(["test message"]);
    expect(validated).toHaveLength(1);
    expect(validated[0]?.role).toEqual("user");
  });
});
