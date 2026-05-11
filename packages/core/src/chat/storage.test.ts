import type { AtlasUIMessage } from "@atlas/agent-sdk";
import { connect, type NatsConnection } from "nats";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startNatsTestServer, type TestNatsServer } from "../test-utils/nats-test-server.ts";
import { ChatStorage, initChatStorage } from "./storage.ts";

let server: TestNatsServer;
let nc: NatsConnection;

beforeAll(async () => {
  server = await startNatsTestServer();
  nc = await connect({ servers: server.url });
  initChatStorage(nc);
}, 30_000);

afterAll(async () => {
  await nc.drain();
  await server.stop();
});

const createMessage = (text: string): AtlasUIMessage => ({
  id: crypto.randomUUID(),
  role: "user",
  parts: [{ type: "text", text }],
});

const createTestChat = (chatId: string, workspaceId = "friday-conversation") =>
  ChatStorage.createChat({ chatId, userId: "test-user", workspaceId, source: "atlas" });

describe("ChatStorage (JetStream-backed)", () => {
  it("creates and retrieves a chat", async () => {
    const chatId = crypto.randomUUID();
    const create = await createTestChat(chatId);
    expect(create.ok).toBe(true);

    const get = await ChatStorage.getChat(chatId);
    expect(get.ok && get.data).toBeTruthy();
    if (get.ok && get.data) {
      expect(get.data.userId).toBe("test-user");
      expect(get.data.color).toBeDefined();
    }
  });

  it("returns null for a non-existent chat", async () => {
    const result = await ChatStorage.getChat(crypto.randomUUID());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toBeNull();
  });

  it("appends and retrieves messages", async () => {
    const chatId = crypto.randomUUID();
    await createTestChat(chatId);

    const msg = createMessage("hello");
    const append = await ChatStorage.appendMessage(chatId, msg);
    expect(append.ok).toBe(true);

    const get = await ChatStorage.getChat(chatId);
    expect(get.ok && get.data?.messages.length).toBe(1);
    if (get.ok && get.data) {
      expect(get.data.messages[0]?.id).toBe(msg.id);
    }
  });

  it("isolates messages between different chats", async () => {
    const a = crypto.randomUUID();
    const b = crypto.randomUUID();
    await createTestChat(a);
    await createTestChat(b);

    await ChatStorage.appendMessage(a, createMessage("a1"));
    await ChatStorage.appendMessage(b, createMessage("b1"));
    await ChatStorage.appendMessage(b, createMessage("b2"));

    const ga = await ChatStorage.getChat(a);
    const gb = await ChatStorage.getChat(b);
    expect(ga.ok && ga.data?.messages.length).toBe(1);
    expect(gb.ok && gb.data?.messages.length).toBe(2);
  });

  it("workspace-scoped getChat is distinct from global", async () => {
    const chatId = crypto.randomUUID();
    await ChatStorage.createChat({
      chatId,
      userId: "u",
      workspaceId: "scoped_ws",
      source: "atlas",
    });

    const wsRes = await ChatStorage.getChat(chatId, "scoped_ws");
    expect(wsRes.ok && wsRes.data).toBeTruthy();

    const globalRes = await ChatStorage.getChat(chatId);
    expect(globalRes.ok && globalRes.data).toBeNull();
  });

  it("setSystemPromptContext overwrites on each call (latest wins)", async () => {
    const chatId = crypto.randomUUID();
    await createTestChat(chatId);

    await ChatStorage.setSystemPromptContext(chatId, { systemMessages: ["a", "b"] });
    await ChatStorage.setSystemPromptContext(chatId, { systemMessages: ["c"] });

    const get = await ChatStorage.getChat(chatId);
    if (get.ok && get.data) {
      expect(get.data.systemPromptContext?.systemMessages).toEqual(["c"]);
    } else {
      throw new Error("expected chat");
    }
  });

  it("addContentFilteredMessageIds dedupes", async () => {
    const chatId = crypto.randomUUID();
    await createTestChat(chatId);

    await ChatStorage.addContentFilteredMessageIds(chatId, ["m1", "m2"]);
    await ChatStorage.addContentFilteredMessageIds(chatId, ["m2", "m3"]);

    const get = await ChatStorage.getChat(chatId);
    if (get.ok && get.data) {
      expect(get.data.contentFilteredMessageIds?.sort()).toEqual(["m1", "m2", "m3"]);
    } else {
      throw new Error("expected chat");
    }
  });

  it("updateChatTitle persists the title", async () => {
    const chatId = crypto.randomUUID();
    await createTestChat(chatId);
    const result = await ChatStorage.updateChatTitle(chatId, "My Chat");
    expect(result.ok).toBe(true);

    const get = await ChatStorage.getChat(chatId);
    if (get.ok && get.data) expect(get.data.title).toBe("My Chat");
  });

  it("deleteChat removes both metadata and messages", async () => {
    const chatId = crypto.randomUUID();
    await createTestChat(chatId);
    await ChatStorage.appendMessage(chatId, createMessage("bye"));

    const del = await ChatStorage.deleteChat(chatId);
    expect(del.ok).toBe(true);

    const get = await ChatStorage.getChat(chatId);
    expect(get.ok && get.data).toBeNull();
  });

  it("idempotent dedup: same Friday-Message-Id stored once", async () => {
    const chatId = crypto.randomUUID();
    await createTestChat(chatId);

    const msg = createMessage("once");
    await ChatStorage.appendMessage(chatId, msg);
    await ChatStorage.appendMessage(chatId, msg);

    const get = await ChatStorage.getChat(chatId);
    expect(get.ok && get.data?.messages.length).toBe(1);
  });

  it("snapshot replacement: re-appending same id with new content overwrites prior", async () => {
    const chatId = crypto.randomUUID();
    await createTestChat(chatId);

    // First snapshot — partial assistant message with one part.
    const msgId = crypto.randomUUID();
    const v1: AtlasUIMessage = {
      id: msgId,
      role: "assistant",
      parts: [{ type: "text", text: "hello" }],
    };
    await ChatStorage.appendMessage(chatId, v1);

    // Second snapshot — same id, more content. This is the incremental
    // snapshot path: the agent's onFinish callback running after an abort
    // would re-publish the message with whatever was assembled at that point.
    const v2: AtlasUIMessage = {
      id: msgId,
      role: "assistant",
      parts: [
        { type: "text", text: "hello" },
        { type: "text", text: " world" },
      ],
    };
    await ChatStorage.appendMessage(chatId, v2);

    const get = await ChatStorage.getChat(chatId);
    expect(get.ok && get.data?.messages.length).toBe(1);
    if (get.ok && get.data) {
      const stored = get.data.messages[0];
      expect(stored?.parts.length).toBe(2);
    }
  });

  it("listChatsByWorkspace returns chats for one workspace", async () => {
    const wsId = `list-test-${crypto.randomUUID()}`;
    const a = crypto.randomUUID();
    const b = crypto.randomUUID();
    await ChatStorage.createChat({ chatId: a, userId: "u", workspaceId: wsId, source: "atlas" });
    await ChatStorage.createChat({ chatId: b, userId: "u", workspaceId: wsId, source: "atlas" });

    const result = await ChatStorage.listChatsByWorkspace(wsId);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.chats.length).toBe(2);
    }
  });

  it("supports chatIds with colons (telegram-shaped)", async () => {
    // NATS KV keys reject `:` (`/^[-/=.\w]+$/`). Telegram chatIds carry the
    // shape `telegram:<id>` — the storage must sanitize the lookup key while
    // keeping the original id in metadata. Regression test for the broken
    // path where appendMessage / getChat threw "invalid key:" on telegram
    // chats and the agent ran with empty history.
    const chatId = `telegram:${crypto.randomUUID()}`;
    const wsId = `ws-colon-${crypto.randomUUID()}`;
    const create = await ChatStorage.createChat({
      chatId,
      userId: "tg-user",
      workspaceId: wsId,
      source: "telegram",
    });
    expect(create.ok).toBe(true);

    const append = await ChatStorage.appendMessage(chatId, createMessage("hi"), wsId);
    expect(append.ok).toBe(true);

    const get = await ChatStorage.getChat(chatId, wsId);
    expect(get.ok && get.data).toBeTruthy();
    if (get.ok && get.data) {
      expect(get.data.id).toBe(chatId);
      expect(get.data.messages.length).toBe(1);
    }

    const list = await ChatStorage.listChatsByWorkspace(wsId);
    expect(list.ok && list.data.chats.length).toBe(1);
  });

  it("sorts messages by metadata.startTimestamp / .timestamp on read", async () => {
    const chatId = crypto.randomUUID();
    await createTestChat(chatId);

    // Append in completion order; expect chronological order on read.
    const a: AtlasUIMessage = {
      id: crypto.randomUUID(),
      role: "assistant",
      parts: [{ type: "text", text: "first-started" }],
      metadata: { startTimestamp: "2026-04-01T00:00:00Z" },
    };
    const b: AtlasUIMessage = {
      id: crypto.randomUUID(),
      role: "assistant",
      parts: [{ type: "text", text: "second-started" }],
      metadata: { startTimestamp: "2026-04-01T01:00:00Z" },
    };

    // Append b first, then a — read should reorder to a, b.
    await ChatStorage.appendMessage(chatId, b);
    await ChatStorage.appendMessage(chatId, a);

    const get = await ChatStorage.getChat(chatId);
    if (get.ok && get.data) {
      expect(get.data.messages.map((m) => m.id)).toEqual([a.id, b.id]);
    }
  });
});
