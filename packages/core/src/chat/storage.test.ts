import { writeFile } from "node:fs/promises";
import process from "node:process";
import { makeTempDir } from "@atlas/utils/temp.server";
import type { AtlasUIMessage } from "@atlas/agent-sdk";
import { validateAtlasUIMessages } from "@atlas/agent-sdk";
import { assert, assertEquals, assertExists } from "@std/assert";
import { join } from "@std/path";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
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
    await Deno.remove(testDir, { recursive: true });
  } catch {
    // Ignore cleanup errors
  }
});

const createTestChat = (chatId: string) =>
  ChatStorage.createChat({ chatId, userId: "test-user", workspaceId: "test-ws", source: "atlas" });

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
      assert(result.ok);

      const getResult = await ChatStorage.getChat(chatId);
      assert(getResult.ok);
      assertEquals(getResult.data?.userId, "test-user");
      assertEquals(getResult.data?.workspaceId, "test-ws");
    });

    it("appends and retrieves messages", async () => {
      const chatId = crypto.randomUUID();
      await createTestChat(chatId);

      const message = createMessage("Hello");
      const appendResult = await ChatStorage.appendMessage(chatId, message);
      assert(appendResult.ok);

      const chatResult = await ChatStorage.getChat(chatId);
      assert(chatResult.ok);
      assertEquals(chatResult.data?.messages.length, 1);
      assertEquals(chatResult.data?.messages[0]?.id, message.id);
    });

    it("returns null for non-existent chat", async () => {
      const result = await ChatStorage.getChat(crypto.randomUUID());
      assert(result.ok);
      assertEquals(result.data, null);
    });

    it("returns empty array for chat with no messages", async () => {
      const chatId = crypto.randomUUID();
      await createTestChat(chatId);

      const result = await ChatStorage.getChat(chatId);
      assert(result.ok);
      assertEquals(result.data?.messages.length, 0);
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

      assert(chat1.ok && chat2.ok);
      assertEquals(chat1.data?.messages.length, 1);
      assertEquals(chat2.data?.messages.length, 1);
      assertEquals(chat1.data?.messages[0]?.id, msg1.id);
      assertEquals(chat2.data?.messages[0]?.id, msg2.id);
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
      assert(result.ok);
      assertEquals(result.data?.messages.length, 3);
      assertEquals(result.data?.messages[0]?.id, ids[0]);
      assertEquals(result.data?.messages[1]?.id, ids[1]);
      assertEquals(result.data?.messages[2]?.id, ids[2]);
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
      assert(result.ok);
      assertEquals(result.data?.messages.length, 5);
      // All messages stored in order
      for (let i = 0; i < 5; i++) {
        assertEquals(result.data?.messages[i]?.id, ids[i]);
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
      assert(storeResult.ok, "Should store 500KB message");

      const retrieveResult = await ChatStorage.getChat(chatId);
      assert(
        retrieveResult.ok,
        `Failed to retrieve: ${retrieveResult.ok ? "" : retrieveResult.error}`,
      );
      assertEquals(retrieveResult.data?.messages.length, 1);

      const retrieved = retrieveResult.data?.messages[0];
      assertExists(retrieved);
      assertEquals(retrieved.id, message.id);
      assertEquals(retrieved.parts.length, 1);

      const textPart = retrieved.parts[0];
      assert(textPart && textPart.type === "text");
      if ("text" in textPart) {
        assertEquals(textPart.text, largeText, "Large text should be preserved");
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
        assert(result.ok, "All concurrent appends should succeed");
      }

      const chatResult = await ChatStorage.getChat(chatId);
      assert(chatResult.ok);
      assert(chatResult.data);
      assertEquals(chatResult.data.messages.length, 10, "File locking should prevent data loss");

      const retrievedIds = new Set(chatResult.data.messages.map((m) => m.id));
      for (const id of ids) {
        assert(retrievedIds.has(id), `All messages should be present`);
      }
    });
  });

  describe("Validation", () => {
    const testValidation = async (description: string, corruptData: object) => {
      const chatId = crypto.randomUUID();
      await createTestChat(chatId);
      await corruptChatFile(chatId, corruptData);

      const result = await ChatStorage.getChat(chatId);
      assert(!result.ok, description);
      assert(
        result.error.includes("Invalid chat data format"),
        `Should mention validation: ${result.error}`,
      );
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
      assert(result1.ok);

      const message = createMessage("Important message");
      const appendResult = await ChatStorage.appendMessage(chatId, message);
      assert(appendResult.ok);

      const titleResult = await ChatStorage.updateChatTitle(chatId, "Important Chat");
      assert(titleResult.ok);

      const result2 = await createTestChat(chatId);
      assert(result2.ok, "Second createChat should succeed");

      const finalChat = await ChatStorage.getChat(chatId);
      assert(finalChat.ok);
      assertEquals(finalChat.data?.messages.length, 1, "Message should be preserved");
      assertEquals(finalChat.data?.messages[0]?.id, message.id, "Message ID should match");
      assertEquals(finalChat.data?.title, "Important Chat", "Title should be preserved");
      assertEquals(
        finalChat.data?.createdAt,
        result1.data.createdAt,
        "Created timestamp should not change",
      );
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
      assert(chat.ok);
      assertEquals(chat.data?.messages.length, 2, "Both messages should exist");
      assertEquals(chat.data?.messages[0]?.id, msg1.id, "First message preserved");
      assertEquals(chat.data?.messages[1]?.id, msg2.id, "Second message preserved");
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
      assert(reconnectResult.ok, "Reconnection should succeed");

      // 4. Continue conversation
      const userMsg2 = createMessage("What is my secret number again?");
      await ChatStorage.appendMessage(chatId, userMsg2);

      // 5. Verify full history preserved
      const finalChat = await ChatStorage.getChat(chatId);
      assert(finalChat.ok);
      assertEquals(finalChat.data?.messages.length, 3, "All 3 messages should exist");
      const hasSecretNumber = finalChat.data?.messages.some((msg) =>
        msg.parts?.some((part) => part.type === "text" && part.text?.includes("4123")),
      );
      assert(hasSecretNumber, "Historical context preserved");
    });

    it("handles rapid successive createChat calls", async () => {
      const chatId = crypto.randomUUID();
      const promises = Array(5)
        .fill(0)
        .map(() => createTestChat(chatId));
      const results = await Promise.all(promises);

      for (const result of results) {
        assert(result.ok, "All createChat calls should succeed");
      }

      const message = createMessage("Test message");
      await ChatStorage.appendMessage(chatId, message);

      const chat = await ChatStorage.getChat(chatId);
      assert(chat.ok);
      assertEquals(chat.data?.messages.length, 1, "Should have exactly one message");
      assertEquals(chat.data?.userId, "test-user", "User ID should be consistent");
      assertEquals(chat.data?.workspaceId, "test-ws", "Workspace ID should be consistent");
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
      assert(result.ok);
      assertEquals(result.data.chats.length, 3);
      assertEquals(result.data.chats[0]?.id, chat1, "Most recently updated should be first");
    });

    it("only reads top N files by mtime", async () => {
      for (let i = 0; i < 10; i++) {
        await createTestChat(crypto.randomUUID());
        await new Promise((resolve) => setTimeout(resolve, 5));
      }

      const result = await ChatStorage.listChats({ limit: 3 });
      assert(result.ok);
      assertEquals(result.data.chats.length, 3, "Should return exactly 3 of 10 chats");
    });
  });
});
