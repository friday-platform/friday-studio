import type { AtlasUIMessage } from "@atlas/agent-sdk";
import { assert, assertEquals } from "@std/assert";
import { ChatStorage } from "./storage.ts";

Deno.test("ChatStorage - create and retrieve chat", async () => {
  using kv = await Deno.openKv(":memory:");
  const chatId = `test-${crypto.randomUUID()}`;

  const createResult = await ChatStorage.createChat(
    { chatId, userId: "test-user", workspaceId: "test-ws" },
    kv,
  );

  assert(createResult.ok);

  const getResult = await ChatStorage.getChat(chatId, kv);
  assert(getResult.ok);
  assertEquals(getResult.data?.userId, "test-user");
  assertEquals(getResult.data?.workspaceId, "test-ws");
});

Deno.test("ChatStorage - append and retrieve messages", async () => {
  using kv = await Deno.openKv(":memory:");
  const chatId = `test-${crypto.randomUUID()}`;
  await ChatStorage.createChat({ chatId, userId: "test-user", workspaceId: "test-ws" }, kv);

  const message: AtlasUIMessage = {
    id: crypto.randomUUID(),
    role: "user",
    parts: [{ type: "text", text: "Hello" }],
  };

  const appendResult = await ChatStorage.appendMessage(chatId, message, kv);
  assert(appendResult.ok);

  const messagesResult = await ChatStorage.getMessages(chatId, kv);
  assert(messagesResult.ok);
  assertEquals(messagesResult.data.length, 1);
  assertEquals(messagesResult.data[0]?.id, message.id);
});

Deno.test("ChatStorage - retrieve non-existent chat returns null", async () => {
  using kv = await Deno.openKv(":memory:");
  const chatId = `nonexistent-${crypto.randomUUID()}`;

  const result = await ChatStorage.getChat(chatId, kv);
  assert(result.ok);
  assertEquals(result.data, null);
});

Deno.test("ChatStorage - multiple messages in order", async () => {
  using kv = await Deno.openKv(":memory:");
  const chatId = `test-${crypto.randomUUID()}`;
  await ChatStorage.createChat({ chatId, userId: "test-user", workspaceId: "test-ws" }, kv);

  const msg1Id = crypto.randomUUID();
  const msg2Id = crypto.randomUUID();
  const msg3Id = crypto.randomUUID();

  await ChatStorage.appendMessage(
    chatId,
    { id: msg1Id, role: "user", parts: [{ type: "text", text: "First" }] },
    kv,
  );

  // Small delay to ensure different timestamps
  await new Promise((resolve) => setTimeout(resolve, 2));

  await ChatStorage.appendMessage(
    chatId,
    { id: msg2Id, role: "assistant", parts: [{ type: "text", text: "Second" }] },
    kv,
  );

  await new Promise((resolve) => setTimeout(resolve, 2));

  await ChatStorage.appendMessage(
    chatId,
    { id: msg3Id, role: "user", parts: [{ type: "text", text: "Third" }] },
    kv,
  );

  const result = await ChatStorage.getMessages(chatId, kv);
  assert(result.ok);
  assertEquals(result.data.length, 3);
  assertEquals(result.data[0]?.id, msg1Id);
  assertEquals(result.data[1]?.id, msg2Id);
  assertEquals(result.data[2]?.id, msg3Id);
});

Deno.test("ChatStorage - limit messages retrieval", async () => {
  using kv = await Deno.openKv(":memory:");
  const chatId = `test-${crypto.randomUUID()}`;
  await ChatStorage.createChat({ chatId, userId: "test-user", workspaceId: "test-ws" }, kv);

  for (let i = 0; i < 5; i++) {
    await ChatStorage.appendMessage(
      chatId,
      { id: crypto.randomUUID(), role: "user", parts: [{ type: "text", text: `Message ${i}` }] },
      kv,
    );
  }

  const result = await ChatStorage.getMessages(chatId, kv, 3);
  assert(result.ok);
  assertEquals(result.data.length, 3);
});

Deno.test("ChatStorage - empty chat returns empty messages", async () => {
  using kv = await Deno.openKv(":memory:");
  const chatId = `test-${crypto.randomUUID()}`;
  await ChatStorage.createChat({ chatId, userId: "test-user", workspaceId: "test-ws" }, kv);

  const result = await ChatStorage.getMessages(chatId, kv);
  assert(result.ok);
  assertEquals(result.data.length, 0);
});

Deno.test("ChatStorage - messages from different chats don't interfere", async () => {
  using kv = await Deno.openKv(":memory:");
  const chatId1 = `test-${crypto.randomUUID()}`;
  const chatId2 = `test-${crypto.randomUUID()}`;

  await ChatStorage.createChat({ chatId: chatId1, userId: "user1", workspaceId: "test-ws" }, kv);
  await ChatStorage.createChat({ chatId: chatId2, userId: "user2", workspaceId: "test-ws" }, kv);

  const msg1Id = crypto.randomUUID();
  const msg2Id = crypto.randomUUID();

  await ChatStorage.appendMessage(
    chatId1,
    { id: msg1Id, role: "user", parts: [{ type: "text", text: "Chat 1 message" }] },
    kv,
  );

  await ChatStorage.appendMessage(
    chatId2,
    { id: msg2Id, role: "user", parts: [{ type: "text", text: "Chat 2 message" }] },
    kv,
  );

  const messages1 = await ChatStorage.getMessages(chatId1, kv);
  const messages2 = await ChatStorage.getMessages(chatId2, kv);

  assert(messages1.ok);
  assert(messages2.ok);
  assertEquals(messages1.data.length, 1);
  assertEquals(messages2.data.length, 1);
  assertEquals(messages1.data[0]?.id, msg1Id);
  assertEquals(messages2.data[0]?.id, msg2Id);
});
