import type { AtlasUIMessage } from "@atlas/agent-sdk";
import { fail, type Result, success } from "@atlas/utils";
import { getAtlasHome } from "@atlas/utils/paths.server";
import { join } from "@std/path";

interface Chat {
  id: string; // Same as streamId
  userId: string;
  workspaceId: string;
  title?: string;
  createdAt: string;
  updatedAt: string;
}

// Key types for type safety
type ChatKey = ["chat", string];
type MessageKey = ["chat_message", string, string]; // [prefix, chatId, timestamp-messageId]

const keys = {
  chat: (id: string): ChatKey => ["chat", id],
  message: (chatId: string, timestamp: string, messageId: string): MessageKey => [
    "chat_message",
    chatId,
    `${timestamp}-${messageId}`,
  ],
};

const kvPath = join(getAtlasHome(), "storage.db");

/** Create chat */
async function createChat(
  input: { chatId: string; userId: string; workspaceId: string },
  kv?: Deno.Kv,
): Promise<Result<Chat, string>> {
  const shouldClose = !kv;
  const db = kv ?? (await Deno.openKv(kvPath));

  try {
    const chat: Chat = {
      id: input.chatId,
      userId: input.userId,
      workspaceId: input.workspaceId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const result = await db.set(keys.chat(input.chatId), chat);
    if (!result.ok) {
      return fail("Failed to create chat");
    }

    return success(chat);
  } finally {
    if (shouldClose) db.close();
  }
}

/** Append message to chat */
async function appendMessage(
  chatId: string,
  message: AtlasUIMessage,
  kv?: Deno.Kv,
): Promise<Result<void, string>> {
  const shouldClose = !kv;
  const db = kv ?? (await Deno.openKv(kvPath));

  try {
    const timestamp = new Date().toISOString();
    const messageKey = keys.message(chatId, timestamp, message.id);

    const result = await db.set(messageKey, message);
    if (!result.ok) {
      return fail("Failed to append message");
    }

    return success(undefined);
  } finally {
    if (shouldClose) db.close();
  }
}

/** Get chat by ID */
async function getChat(chatId: string, kv?: Deno.Kv): Promise<Result<Chat | null, string>> {
  const shouldClose = !kv;
  const db = kv ?? (await Deno.openKv(kvPath));

  try {
    const result = await db.get<Chat>(keys.chat(chatId));
    return success(result.value || null);
  } finally {
    if (shouldClose) db.close();
  }
}

/** Get chat messages */
async function getMessages(
  chatId: string,
  kv?: Deno.Kv,
  limit = 100,
): Promise<Result<AtlasUIMessage[], string>> {
  const shouldClose = !kv;
  const db = kv ?? (await Deno.openKv(kvPath));

  try {
    const messages: AtlasUIMessage[] = [];
    const entries = db.list<AtlasUIMessage>({ prefix: ["chat_message", chatId] });

    for await (const entry of entries) {
      if (messages.length >= limit) break;
      if (entry.value) {
        messages.push(entry.value);
      }
    }

    return success(messages);
  } finally {
    if (shouldClose) db.close();
  }
}

/** List recent chats */
async function listChats(kv?: Deno.Kv, limit = 5): Promise<Result<Chat[], string>> {
  const shouldClose = !kv;
  const db = kv ?? (await Deno.openKv(kvPath));

  try {
    const chats: Chat[] = [];
    const entries = db.list<Chat>({ prefix: ["chat"] });

    for await (const entry of entries) {
      if (entry.value) {
        chats.push(entry.value);
      }
    }

    // Sort by updatedAt descending (most recent first)
    chats.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

    return success(chats.slice(0, limit));
  } finally {
    if (shouldClose) db.close();
  }
}

/** Update chat title */
async function updateChatTitle(
  chatId: string,
  title: string,
  kv?: Deno.Kv,
): Promise<Result<Chat, string>> {
  const shouldClose = !kv;
  const db = kv ?? (await Deno.openKv(kvPath));

  try {
    const result = await db.get<Chat>(keys.chat(chatId));
    if (!result.value) {
      return fail("Chat not found");
    }

    const updatedChat: Chat = { ...result.value, title, updatedAt: new Date().toISOString() };

    const setResult = await db.set(keys.chat(chatId), updatedChat);
    if (!setResult.ok) {
      return fail("Failed to update chat title");
    }

    return success(updatedChat);
  } finally {
    if (shouldClose) db.close();
  }
}

export const ChatStorage = {
  createChat,
  getChat,
  appendMessage,
  getMessages,
  listChats,
  updateChatTitle,
};
