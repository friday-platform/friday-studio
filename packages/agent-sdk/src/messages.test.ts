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
});
