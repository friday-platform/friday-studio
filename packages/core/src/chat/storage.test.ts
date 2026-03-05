import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import type { AtlasUIMessage } from "@atlas/agent-sdk";
import { validateAtlasUIMessages } from "@atlas/agent-sdk";
import { makeTempDir } from "@atlas/utils/temp.server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChatStorage } from "./storage.ts";

let originalAtlasHome: string | undefined;
let testDir: string;

beforeEach(() => {
  testDir = makeTempDir({ prefix: "atlas_chat_test_" });
  originalAtlasHome = process.env.ATLAS_HOME;
  process.env.ATLAS_HOME = testDir;
});

afterEach(async () => {
  if (originalAtlasHome) {
    process.env.ATLAS_HOME = originalAtlasHome;
  } else {
    delete process.env.ATLAS_HOME;
  }
  try {
    await rm(testDir, { recursive: true });
  } catch {
    // Ignore cleanup errors
  }
});

const createTestChat = (chatId: string) =>
  ChatStorage.createChat({
    chatId,
    userId: "test-user",
    workspaceId: "friday-conversation",
    source: "atlas",
  });

const createMessage = (text: string): AtlasUIMessage => ({
  id: crypto.randomUUID(),
  role: "user",
  parts: [{ type: "text", text }],
});

const corruptChatFile = async (chatId: string, data: object) => {
  const chatFile = join(testDir, "chats", `${chatId}.json`);
  await writeFile(chatFile, JSON.stringify(data), "utf-8");
};

describe("ChatStorage", () => {
  describe("Basic operations", () => {
    it("creates and retrieves chat", async () => {
      const chatId = crypto.randomUUID();
      const result = await createTestChat(chatId);
      expect.assert(result.ok);

      const getResult = await ChatStorage.getChat(chatId);
      expect.assert(getResult.ok && getResult.data);
      expect(getResult.data.userId).toEqual("test-user");
      expect(getResult.data.workspaceId).toEqual("friday-conversation");
      expect(getResult.data.color).toBeDefined();
    });

    it("appends and retrieves messages", async () => {
      const chatId = crypto.randomUUID();
      await createTestChat(chatId);

      const message = createMessage("Hello");
      const appendResult = await ChatStorage.appendMessage(chatId, message);
      expect.assert(appendResult.ok);

      const chatResult = await ChatStorage.getChat(chatId);
      expect.assert(chatResult.ok && chatResult.data);
      expect(chatResult.data.messages.length).toEqual(1);
      expect(chatResult.data.messages[0]?.id).toEqual(message.id);
    });

    it("returns null for non-existent chat", async () => {
      const result = await ChatStorage.getChat(crypto.randomUUID());
      expect.assert(result.ok);
      expect(result.data).toBeNull();
    });

    it("returns empty array for chat with no messages", async () => {
      const chatId = crypto.randomUUID();
      await createTestChat(chatId);

      const result = await ChatStorage.getChat(chatId);
      expect.assert(result.ok && result.data);
      expect(result.data.messages.length).toEqual(0);
    });

    it("isolates messages between different chats", async () => {
      const chatId1 = crypto.randomUUID();
      const chatId2 = crypto.randomUUID();
      await createTestChat(chatId1);
      await createTestChat(chatId2);

      const msg1 = createMessage("Chat 1");
      const msg2 = createMessage("Chat 2");
      await ChatStorage.appendMessage(chatId1, msg1);
      await ChatStorage.appendMessage(chatId2, msg2);

      const chat1 = await ChatStorage.getChat(chatId1);
      const chat2 = await ChatStorage.getChat(chatId2);

      expect.assert(chat1.ok && chat1.data && chat2.ok && chat2.data);
      expect(chat1.data.messages.length).toEqual(1);
      expect(chat2.data.messages.length).toEqual(1);
      expect(chat1.data.messages[0]?.id).toEqual(msg1.id);
      expect(chat2.data.messages[0]?.id).toEqual(msg2.id);
    });

    it("sets and retrieves system prompt context", async () => {
      const chatId = crypto.randomUUID();
      await createTestChat(chatId);

      const context = {
        systemMessages: [
          "You are a helpful assistant.",
          "Current datetime (UTC): 2025-12-30T00:00:00Z",
        ],
      };

      const setResult = await ChatStorage.setSystemPromptContext(chatId, context);
      expect.assert(setResult.ok);

      const getResult = await ChatStorage.getChat(chatId);
      expect.assert(getResult.ok && getResult.data);
      expect(getResult.data.systemPromptContext).toBeDefined();
      expect(getResult.data.systemPromptContext?.systemMessages).toEqual(context.systemMessages);
    });

    it("setSystemPromptContext is idempotent", async () => {
      const chatId = crypto.randomUUID();
      await createTestChat(chatId);

      const first = { systemMessages: ["First prompt"] };
      const second = { systemMessages: ["Second prompt"] };

      await ChatStorage.setSystemPromptContext(chatId, first);
      await ChatStorage.setSystemPromptContext(chatId, second);

      const result = await ChatStorage.getChat(chatId);
      expect.assert(result.ok && result.data);
      expect(result.data.systemPromptContext?.systemMessages).toEqual(["First prompt"]);
    });
  });

  describe("Message ordering", () => {
    it("stores messages in append order", async () => {
      const chatId = crypto.randomUUID();
      await createTestChat(chatId);

      const ids = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
      for (const id of ids) {
        await ChatStorage.appendMessage(chatId, {
          id,
          role: "user",
          parts: [{ type: "text", text: "msg" }],
        });
      }

      const result = await ChatStorage.getChat(chatId);
      expect.assert(result.ok && result.data);
      expect(result.data.messages.length).toEqual(3);
      expect(result.data.messages[0]?.id).toEqual(ids[0]);
      expect(result.data.messages[1]?.id).toEqual(ids[1]);
      expect(result.data.messages[2]?.id).toEqual(ids[2]);
    });

    it("stores all messages without limit", async () => {
      const chatId = crypto.randomUUID();
      await createTestChat(chatId);

      const ids: string[] = [];
      for (let i = 0; i < 5; i++) {
        const id = crypto.randomUUID();
        ids.push(id);
        await ChatStorage.appendMessage(chatId, {
          id,
          role: "user",
          parts: [{ type: "text", text: `Message ${i}` }],
        });
      }

      const result = await ChatStorage.getChat(chatId);
      expect.assert(result.ok && result.data);
      expect(result.data.messages.length).toEqual(5);
      // All messages stored in order
      for (let i = 0; i < 5; i++) {
        expect(result.data.messages[i]?.id).toEqual(ids[i]);
      }
    });
  });

  describe("Large messages", () => {
    it("persists 500KB messages without data loss", async () => {
      const chatId = crypto.randomUUID();
      await createTestChat(chatId);

      const largeText = "x".repeat(500000);
      const [message] = await validateAtlasUIMessages([
        { id: crypto.randomUUID(), role: "assistant", parts: [{ type: "text", text: largeText }] },
      ]);
      if (!message) throw new Error("Message validation failed");

      const storeResult = await ChatStorage.appendMessage(chatId, message);
      expect.assert(storeResult.ok);

      const retrieveResult = await ChatStorage.getChat(chatId);
      expect.assert(retrieveResult.ok && retrieveResult.data);
      expect(retrieveResult.data.messages.length).toEqual(1);

      const retrieved = retrieveResult.data.messages[0];
      expect(retrieved).toBeDefined();
      expect(retrieved?.id).toEqual(message.id);
      expect(retrieved?.parts.length).toEqual(1);

      const textPart = retrieved?.parts[0];
      expect(textPart && textPart.type === "text").toBe(true);
      if (textPart && "text" in textPart) {
        expect(textPart.text).toEqual(largeText);
      }
    });
  });

  describe("Concurrency", () => {
    it("prevents data loss with concurrent appends", async () => {
      const chatId = crypto.randomUUID();
      await createTestChat(chatId);

      const ids: string[] = [];
      const promises = [];
      for (let i = 0; i < 10; i++) {
        const id = crypto.randomUUID();
        ids.push(id);
        promises.push(
          ChatStorage.appendMessage(chatId, {
            id,
            role: "user",
            parts: [{ type: "text", text: `${i}` }],
          }),
        );
      }

      const results = await Promise.all(promises);
      for (const result of results) {
        expect.assert(result.ok);
      }

      const chatResult = await ChatStorage.getChat(chatId);
      expect.assert(chatResult.ok && chatResult.data);
      expect(chatResult.data.messages.length).toEqual(10);

      const retrievedIds = new Set(chatResult.data.messages.map((m) => m.id));
      for (const id of ids) {
        expect(retrievedIds.has(id)).toBe(true);
      }
    });
  });

  describe("Validation", () => {
    const testValidation = async (_description: string, corruptData: object) => {
      const chatId = crypto.randomUUID();
      await createTestChat(chatId);
      await corruptChatFile(chatId, corruptData);

      const result = await ChatStorage.getChat(chatId);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("Invalid chat data format");
      }
    };

    it("rejects completely corrupted data", async () => {
      await testValidation("Should reject invalid structure", { corrupted: "data" });
    });

    it("rejects invalid datetime format", async () => {
      const chatId = crypto.randomUUID();
      await testValidation("Should reject invalid datetime", {
        id: chatId,
        userId: "test-user",
        workspaceId: "test-ws",
        source: "atlas",
        createdAt: "not-a-datetime",
        updatedAt: "2025-11-02T12:00:00Z",
        messages: [],
      });
    });

    it("rejects empty userId", async () => {
      const chatId = crypto.randomUUID();
      await testValidation("Should reject empty userId", {
        id: chatId,
        userId: "",
        workspaceId: "test-ws",
        source: "atlas",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messages: [],
      });
    });

    it("rejects empty workspaceId", async () => {
      const chatId = crypto.randomUUID();
      await testValidation("Should reject empty workspaceId", {
        id: chatId,
        userId: "test-user",
        workspaceId: "",
        source: "atlas",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messages: [],
      });
    });

    it("rejects missing source field", async () => {
      const chatId = crypto.randomUUID();
      await testValidation("Should reject missing source", {
        id: chatId,
        userId: "test-user",
        workspaceId: "test-ws",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messages: [],
      });
    });
  });

  describe("Idempotency", () => {
    it("createChat is idempotent - returns existing chat without overwriting", async () => {
      const chatId = crypto.randomUUID();
      const result1 = await createTestChat(chatId);
      expect.assert(result1.ok);

      const message = createMessage("Important message");
      const appendResult = await ChatStorage.appendMessage(chatId, message);
      expect.assert(appendResult.ok);

      const titleResult = await ChatStorage.updateChatTitle(chatId, "Important Chat");
      expect.assert(titleResult.ok);

      const result2 = await createTestChat(chatId);
      expect.assert(result2.ok);

      const finalChat = await ChatStorage.getChat(chatId);
      expect.assert(finalChat.ok && finalChat.data);
      expect(finalChat.data.messages.length).toEqual(1);
      expect(finalChat.data.messages[0]?.id).toEqual(message.id);
      expect(finalChat.data.title).toEqual("Important Chat");
      expect(finalChat.data.createdAt).toEqual(result1.data.createdAt);
    });

    it("preserves messages across multiple createChat calls", async () => {
      const chatId = crypto.randomUUID();
      await createTestChat(chatId);

      const msg1 = createMessage("First message");
      await ChatStorage.appendMessage(chatId, msg1);
      await createTestChat(chatId);

      const msg2 = createMessage("Second message");
      await ChatStorage.appendMessage(chatId, msg2);
      await createTestChat(chatId);

      const chat = await ChatStorage.getChat(chatId);
      expect.assert(chat.ok && chat.data);
      expect(chat.data.messages.length).toEqual(2);
      expect(chat.data.messages[0]?.id).toEqual(msg1.id);
      expect(chat.data.messages[1]?.id).toEqual(msg2.id);
    });

    it("maintains chat continuity in conversation flow", async () => {
      // Regression test: createChat called again on reconnect must not lose chat
      const chatId = crypto.randomUUID();

      // 1. Start conversation
      await createTestChat(chatId);
      const userMsg1 = createMessage("My secret number is 4123");
      await ChatStorage.appendMessage(chatId, userMsg1);

      // 2. Assistant responds
      const assistantMsg1: AtlasUIMessage = {
        id: crypto.randomUUID(),
        role: "assistant",
        parts: [{ type: "text", text: "I've noted your secret number is 4123." }],
      };
      await ChatStorage.appendMessage(chatId, assistantMsg1);

      // 3. Reconnect (bug trigger: createChat called again)
      const reconnectResult = await createTestChat(chatId);
      expect.assert(reconnectResult.ok);

      // 4. Continue conversation
      const userMsg2 = createMessage("What is my secret number again?");
      await ChatStorage.appendMessage(chatId, userMsg2);

      // 5. Verify full history preserved
      const finalChat = await ChatStorage.getChat(chatId);
      expect.assert(finalChat.ok && finalChat.data);
      expect(finalChat.data.messages.length).toEqual(3);
      const hasSecretNumber = finalChat.data.messages.some((msg) =>
        msg.parts?.some((part) => part.type === "text" && part.text?.includes("4123")),
      );
      expect(hasSecretNumber).toBe(true);
    });

    it("handles rapid successive createChat calls", async () => {
      const chatId = crypto.randomUUID();
      // Serialize to avoid file-system write races on the same chatId
      for (let i = 0; i < 5; i++) {
        const result = await createTestChat(chatId);
        expect.assert(result.ok);
      }

      const message = createMessage("Test message");
      await ChatStorage.appendMessage(chatId, message);

      const chat = await ChatStorage.getChat(chatId);
      expect.assert(chat.ok && chat.data);
      expect(chat.data.messages.length).toEqual(1);
      expect(chat.data.userId).toEqual("test-user");
      expect(chat.data.workspaceId).toEqual("friday-conversation");
    });
  });

  describe("addContentFilteredMessageIds", () => {
    it("adds message IDs and persists them", async () => {
      const chatId = crypto.randomUUID();
      await createTestChat(chatId);

      const msgId = crypto.randomUUID();
      const result = await ChatStorage.addContentFilteredMessageIds(chatId, [msgId]);
      expect.assert(result.ok);

      const chat = await ChatStorage.getChat(chatId);
      expect.assert(chat.ok && chat.data);
      expect(chat.data.contentFilteredMessageIds).toEqual([msgId]);
    });

    it("deduplicates message IDs across calls", async () => {
      const chatId = crypto.randomUUID();
      await createTestChat(chatId);

      const msgId1 = crypto.randomUUID();
      const msgId2 = crypto.randomUUID();

      await ChatStorage.addContentFilteredMessageIds(chatId, [msgId1]);
      await ChatStorage.addContentFilteredMessageIds(chatId, [msgId1, msgId2]);

      const chat = await ChatStorage.getChat(chatId);
      expect.assert(chat.ok && chat.data);
      expect(chat.data.contentFilteredMessageIds).toHaveLength(2);
      expect(new Set(chat.data.contentFilteredMessageIds)).toEqual(new Set([msgId1, msgId2]));
    });

    it("returns error for non-existent chat", async () => {
      const result = await ChatStorage.addContentFilteredMessageIds("nonexistent", ["msg-1"]);
      expect(result.ok).toBe(false);
    });

    it("does not affect existing chat data", async () => {
      const chatId = crypto.randomUUID();
      await createTestChat(chatId);

      const msg = createMessage("Important message");
      await ChatStorage.appendMessage(chatId, msg);

      await ChatStorage.addContentFilteredMessageIds(chatId, [crypto.randomUUID()]);

      const chat = await ChatStorage.getChat(chatId);
      expect.assert(chat.ok && chat.data);
      expect(chat.data.messages).toHaveLength(1);
      expect(chat.data.messages[0]?.id).toEqual(msg.id);
      expect(chat.data.userId).toEqual("test-user");
    });
  });

  describe("listChats", () => {
    it("returns most recently updated first", async () => {
      const chat1 = crypto.randomUUID();
      const chat2 = crypto.randomUUID();
      const chat3 = crypto.randomUUID();

      await createTestChat(chat1);
      await new Promise((resolve) => setTimeout(resolve, 50));
      await createTestChat(chat2);
      await new Promise((resolve) => setTimeout(resolve, 50));
      await createTestChat(chat3);
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Update first chat to make it most recent
      await ChatStorage.appendMessage(chat1, createMessage("Update"));

      const result = await ChatStorage.listChats({ limit: 5 });
      expect.assert(result.ok);
      expect(result.data.chats.length).toEqual(3);
      expect(result.data.chats[0]?.id).toEqual(chat1);
    });

    it("only reads top N files by mtime", async () => {
      for (let i = 0; i < 10; i++) {
        await createTestChat(crypto.randomUUID());
        await new Promise((resolve) => setTimeout(resolve, 5));
      }

      const result = await ChatStorage.listChats({ limit: 3 });
      expect.assert(result.ok);
      expect(result.data.chats.length).toEqual(3);
    });

    it("excludes workspace-scoped chats from global list", async () => {
      const globalChatId = crypto.randomUUID();
      const wsChatId = crypto.randomUUID();

      await createTestChat(globalChatId);
      await ChatStorage.createChat({
        chatId: wsChatId,
        userId: "test-user",
        workspaceId: "my-workspace",
        source: "atlas",
      });

      const result = await ChatStorage.listChats({ limit: 10 });
      expect.assert(result.ok);
      expect(result.data.chats.length).toEqual(1);
      expect(result.data.chats[0]?.id).toEqual(globalChatId);
    });
  });

  describe("Workspace-scoped storage", () => {
    const wsId = "analytics-workspace";

    const createWsChat = (chatId: string) =>
      ChatStorage.createChat({ chatId, userId: "test-user", workspaceId: wsId, source: "atlas" });

    it("stores workspace chats in subdirectory", async () => {
      const chatId = crypto.randomUUID();
      await createWsChat(chatId);

      const result = await ChatStorage.getChat(chatId, wsId);
      expect.assert(result.ok && result.data);
      expect(result.data.workspaceId).toEqual(wsId);
    });

    it("isolates workspace chats from each other", async () => {
      const wsA = "workspace-a";
      const wsB = "workspace-b";
      const chatId = crypto.randomUUID();

      await ChatStorage.createChat({
        chatId,
        userId: "test-user",
        workspaceId: wsA,
        source: "atlas",
      });
      await ChatStorage.appendMessage(chatId, createMessage("Secret A data"), wsA);

      const fromB = await ChatStorage.getChat(chatId, wsB);
      expect.assert(fromB.ok);
      expect(fromB.data).toBeNull();

      const fromA = await ChatStorage.getChat(chatId, wsA);
      expect.assert(fromA.ok && fromA.data);
      expect(fromA.data.messages.length).toEqual(1);
    });

    it("lists only chats for the requested workspace", async () => {
      const wsA = "workspace-a";
      const wsB = "workspace-b";

      await ChatStorage.createChat({
        chatId: crypto.randomUUID(),
        userId: "u",
        workspaceId: wsA,
        source: "atlas",
      });
      await ChatStorage.createChat({
        chatId: crypto.randomUUID(),
        userId: "u",
        workspaceId: wsA,
        source: "atlas",
      });
      await ChatStorage.createChat({
        chatId: crypto.randomUUID(),
        userId: "u",
        workspaceId: wsB,
        source: "atlas",
      });

      const resultA = await ChatStorage.listChatsByWorkspace(wsA);
      expect.assert(resultA.ok);
      expect(resultA.data.chats.length).toEqual(2);

      const resultB = await ChatStorage.listChatsByWorkspace(wsB);
      expect.assert(resultB.ok);
      expect(resultB.data.chats.length).toEqual(1);
    });

    it("workspace chat not visible without workspaceId", async () => {
      const chatId = crypto.randomUUID();
      await createWsChat(chatId);

      const result = await ChatStorage.getChat(chatId);
      expect.assert(result.ok);
      expect(result.data).toBeNull();
    });
  });
});
