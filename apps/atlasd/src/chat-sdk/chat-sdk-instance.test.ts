/**
 * Tests for createMessageHandler — the shared per-message pipeline that
 * subscribes the thread, persists the user message, fires the "chat" signal,
 * and fans events into both StreamRegistry (web) and thread.post (platforms).
 *
 * Strategy: mock only at the external filesystem boundary (ChatStorage).
 * signalToStream, isClientSafeEvent, and StreamRegistry are real.
 */

const { mockAppendMessage } = vi.hoisted(() => ({
  mockAppendMessage: vi.fn<() => Promise<{ ok: boolean; error?: string }>>(),
}));

vi.mock("@atlas/core/chat/storage", () => ({
  ChatStorage: {
    appendMessage: mockAppendMessage,
    createChat: vi.fn().mockResolvedValue({ ok: true }),
    getChat: vi.fn().mockResolvedValue({ ok: true, data: null }),
    deleteChat: vi.fn().mockResolvedValue({ ok: true }),
  },
}));

import type { Message, Thread } from "chat";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { StreamRegistry } from "../stream-registry.ts";
import { createMessageHandler } from "./chat-sdk-instance.ts";

function makeMessage(overrides?: Partial<Message>): Message {
  return {
    id: "msg-1",
    text: "Hello Friday",
    threadId: "chat-123",
    author: { userId: "user-1", userName: "user-1", fullName: "User", isBot: false, isMe: false },
    raw: {},
    formatted: { type: "root", children: [] },
    metadata: { dateSent: new Date(), edited: false },
    attachments: [],
    ...overrides,
  } as Message;
}

function makeThread(id: string) {
  const posted: unknown[] = [];
  return {
    id,
    adapter: { name: "atlas" },
    subscribe: vi.fn().mockResolvedValue(undefined),
    post: vi.fn(async (stream: ReadableStream<unknown>) => {
      for await (const chunk of stream) {
        posted.push(chunk);
      }
      return { id: "sent-1", threadId: id, raw: {} };
    }),
    posted,
  } as unknown as Thread & { posted: unknown[] };
}

/** Synchronously emits chunks via onStreamEvent then resolves. */
function makeTriggerFn(chunks: unknown[]) {
  return vi.fn(
    (
      _signalName: string,
      _payload: Record<string, unknown>,
      _streamId: string,
      onStreamEvent: (chunk: unknown) => void,
    ) => {
      for (const chunk of chunks) {
        onStreamEvent(chunk);
      }
      return Promise.resolve({ sessionId: "sess-1" });
    },
  );
}

beforeEach(() => {
  mockAppendMessage.mockReset();
  mockAppendMessage.mockResolvedValue({ ok: true });
});

describe("createMessageHandler", () => {
  it("subscribes, persists message, propagates datetime, posts stream, finishes registry", async () => {
    const registry = new StreamRegistry();
    const chunks = [
      { type: "text-delta", delta: "Hello" },
      { type: "text-delta", delta: " world" },
    ];
    const triggerFn = makeTriggerFn(chunks);
    const handler = createMessageHandler("ws-test", triggerFn, registry);

    const datetime = {
      timezone: "America/New_York",
      timestamp: "2026-04-02T12:00:00Z",
      localDate: "2026-04-02",
      localTime: "08:00",
      timezoneOffset: "-04:00",
    };

    const thread = makeThread("chat-abc");
    registry.createStream("chat-abc");

    await handler(
      thread,
      makeMessage({ id: "m-1", text: "Hi", threadId: "chat-abc", raw: { datetime } }),
    );

    expect(thread.subscribe).toHaveBeenCalled();
    expect(mockAppendMessage).toHaveBeenCalledWith(
      "chat-abc",
      { id: "m-1", role: "user", parts: [{ type: "text", text: "Hi" }], metadata: {} },
      "ws-test",
    );
    expect(triggerFn).toHaveBeenCalledWith(
      "chat",
      expect.objectContaining({
        chatId: "chat-abc",
        userId: "user-1",
        streamId: "chat-abc",
        datetime,
      }),
      "chat-abc",
      expect.any(Function),
    );

    expect(thread.post).toHaveBeenCalledOnce();
    expect(thread.posted).toEqual(chunks);

    const buffer = registry.getStream("chat-abc");
    expect(buffer?.events).toEqual(chunks);
    expect(buffer?.active).toBe(false);
  });

  it("filters internal FSM events from StreamRegistry but forwards them to thread.post", async () => {
    const registry = new StreamRegistry();
    const chunks = [
      { type: "text-delta", delta: "hi" },
      { type: "data-fsm-action-execution", data: {} },
      { type: "data-session-start", data: {} },
      { type: "data-session-finish", data: {} },
    ];
    const triggerFn = makeTriggerFn(chunks);
    const handler = createMessageHandler("ws-test", triggerFn, registry);

    const thread = makeThread("chat-filter");
    registry.createStream("chat-filter");
    await handler(thread, makeMessage({ threadId: "chat-filter" }));

    // Only client-safe events reach StreamRegistry; thread.post sees them all.
    const types = registry
      .getStream("chat-filter")
      ?.events.map((e) => (e as { type: string }).type);
    expect(types).toEqual(["text-delta", "data-session-start"]);
    expect(thread.posted).toHaveLength(4);
  });

  it("persists pre-validated uiMessage from raw when present (multi-part web payload)", async () => {
    const registry = new StreamRegistry();
    const handler = createMessageHandler(
      "ws-test",
      makeTriggerFn([{ type: "text-delta", delta: "ok" }]),
      registry,
    );

    const thread = makeThread("chat-multipart");
    registry.createStream("chat-multipart");

    const preValidated = {
      id: "msg-with-files",
      role: "user" as const,
      parts: [
        { type: "text" as const, text: "analyze this" },
        {
          type: "data-artifact-attached" as const,
          data: { artifactIds: ["a-1"], filenames: ["sales.csv"], mimeTypes: ["text/csv"] },
        },
      ],
      metadata: {},
    };

    await handler(
      thread,
      makeMessage({
        id: "msg-synthetic-1",
        text: "analyze this",
        threadId: "chat-multipart",
        raw: { uiMessage: preValidated },
      }),
    );

    // The stashed uiMessage is persisted verbatim — NOT the text-only rebuild
    // that toAtlasUIMessage would produce. This preserves data-artifact-attached
    // for downstream consumers (expandArtifactAttachedParts, UI history).
    expect(mockAppendMessage).toHaveBeenCalledWith("chat-multipart", preValidated, "ws-test");
  });

  it("clears the pre-set source when thread.subscribe fails on a slack thread", async () => {
    const registry = new StreamRegistry();
    const stateAdapter = {
      setSource: vi.fn(),
      clearSource: vi.fn(),
    } as unknown as import("@atlas/core/chat/chat-sdk-state-adapter").ChatSdkStateAdapter;
    const handler = createMessageHandler(
      "ws-test",
      makeTriggerFn([{ type: "text-delta", delta: "x" }]),
      registry,
      stateAdapter,
    );

    const thread = makeThread("slack-thread-1");
    (thread as unknown as { adapter: { name: string } }).adapter = { name: "slack" };
    (thread as unknown as { subscribe: ReturnType<typeof vi.fn> }).subscribe = vi
      .fn()
      .mockRejectedValue(new Error("subscribe failed"));

    await expect(handler(thread, makeMessage({ threadId: "slack-thread-1" }))).rejects.toThrow(
      "subscribe failed",
    );

    // Source was pre-set BEFORE subscribe, then cleared in the catch — without
    // this, the threadSources map would leak one entry per failed slack subscribe.
    expect(stateAdapter.setSource).toHaveBeenCalledWith("slack-thread-1", "slack");
    expect(stateAdapter.clearSource).toHaveBeenCalledWith("slack-thread-1");
  });

  it("logs and continues on appendMessage failure, but propagates thread.post errors via finally", async () => {
    const registry = new StreamRegistry();
    const handler = createMessageHandler(
      "ws-test",
      makeTriggerFn([{ type: "text-delta", delta: "x" }]),
      registry,
    );

    // appendMessage failure must NOT abort the handler — signal still fires.
    mockAppendMessage.mockResolvedValueOnce({ ok: false, error: "disk full" });
    const thread = makeThread("chat-err");
    (thread as unknown as { post: ReturnType<typeof vi.fn> }).post = vi
      .fn()
      .mockRejectedValue(new Error("Slack API down"));
    registry.createStream("chat-err");

    await expect(handler(thread, makeMessage({ threadId: "chat-err" }))).rejects.toThrow(
      "Slack API down",
    );
    expect(mockAppendMessage).toHaveBeenCalled();
    // finally block ran even though post threw
    expect(registry.getStream("chat-err")?.active).toBe(false);
  });
});
