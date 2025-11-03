import type { AtlasUIMessage } from "@atlas/agent-sdk";
import { validateAtlasUIMessages } from "@atlas/agent-sdk";
import { assert, assertEquals, assertExists } from "@std/assert";
import { join } from "@std/path";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { ChatStorage } from "./storage.ts";

let originalAtlasHome: string | undefined;
let testDir: string;

beforeEach(async () => {
  testDir = await Deno.makeTempDir({ prefix: "atlas_chat_test_" });
  originalAtlasHome = Deno.env.get("ATLAS_HOME");
  Deno.env.set("ATLAS_HOME", testDir);
});

afterEach(async () => {
  if (originalAtlasHome) {
    Deno.env.set("ATLAS_HOME", originalAtlasHome);
  } else {
    Deno.env.delete("ATLAS_HOME");
  }
  try {
    await Deno.remove(testDir, { recursive: true });
  } catch {
    // Ignore cleanup errors
  }
});

// Test helpers
const createTestChat = (chatId: string) =>
  ChatStorage.createChat({ chatId, userId: "test-user", workspaceId: "test-ws" });

const createMessage = (text: string): AtlasUIMessage => ({
  id: crypto.randomUUID(),
  role: "user",
  parts: [{ type: "text", text }],
});

const corruptChatFile = async (chatId: string, data: object) => {
  const chatFile = join(testDir, "chats", `${chatId}.json`);
  await Deno.writeTextFile(chatFile, JSON.stringify(data));
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
      assertEquals(result.data?.messages[0]?.id, ids[0]); // First
      assertEquals(result.data?.messages[1]?.id, ids[1]);
      assertEquals(result.data?.messages[2]?.id, ids[2]); // Last
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
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messages: [],
      });
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

      const result = await ChatStorage.listChats(5);
      assert(result.ok);
      assertEquals(result.data.length, 3);
      assertEquals(result.data[0]?.id, chat1, "Most recently updated should be first");
    });

    it("only reads top N files by mtime", async () => {
      for (let i = 0; i < 10; i++) {
        await createTestChat(crypto.randomUUID());
        await new Promise((resolve) => setTimeout(resolve, 5));
      }

      const result = await ChatStorage.listChats(3);
      assert(result.ok);
      assertEquals(result.data.length, 3, "Should return exactly 3 of 10 chats");
    });
  });
});
