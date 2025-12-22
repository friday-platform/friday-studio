import { mkdir, readdir, readFile } from "node:fs/promises";
import type { AtlasUIMessage } from "@atlas/agent-sdk";
import { validateAtlasUIMessages } from "@atlas/agent-sdk";
import { createLogger } from "@atlas/logger";
import { fail, isErrnoException, type Result, stringifyError, success } from "@atlas/utils";
import { getAtlasHome } from "@atlas/utils/paths.server";
import { join } from "@std/path";
import { z } from "zod";

const logger = createLogger({ component: "chat-storage" });

/**
 * Chat structure on disk.
 * Messages validated separately via validateAtlasUIMessages (allows partial reads).
 */
const StoredChatSchema = z.object({
  id: z.uuid(),
  userId: z.string().min(1),
  workspaceId: z.string().min(1),
  source: z.enum(["atlas", "slack", "discord"]),
  title: z.string().optional(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  messages: z.array(z.unknown()),
});

type Chat = Omit<z.infer<typeof StoredChatSchema>, "messages"> & { messages: AtlasUIMessage[] };

/** Chats directory path */
function getChatDir(): string {
  return join(getAtlasHome(), "chats");
}

/** Chat file path for given ID */
function getChatFile(chatId: string): string {
  return join(getChatDir(), `${chatId}.json`);
}

/** Create chats directory if missing */
async function ensureChatDir(): Promise<void> {
  await mkdir(getChatDir(), { recursive: true });
}

/**
 * Read + validate chat from disk.
 * Throws: file not found, JSON parse error, schema validation error, message validation error
 */
async function readAndValidateChat(filePath: string): Promise<Chat> {
  const content = await readFile(filePath, "utf-8");
  const json = JSON.parse(content);
  const parsedChat = StoredChatSchema.parse(json);
  const messages = await validateAtlasUIMessages(parsedChat.messages);
  return { ...parsedChat, messages };
}

/**
 * Create chat if not exists, else return existing (idempotent).
 *
 * Safe for client reconnection pattern (multiple calls with same ID).
 * If existing chat corrupted: logs warning, overwrites with fresh chat.
 */
async function createChat(input: {
  chatId: string;
  userId: string;
  workspaceId: string;
  source: "atlas" | "slack" | "discord";
}): Promise<Result<Chat, string>> {
  try {
    await ensureChatDir();
    const chatFile = getChatFile(input.chatId);

    try {
      const existing = await readAndValidateChat(chatFile);
      logger.debug("Chat already exists, returning existing", {
        chatId: input.chatId,
        messageCount: existing.messages.length,
      });
      return success(existing);
    } catch (error) {
      if (!(isErrnoException(error) && error.code === "ENOENT")) {
        logger.warn("Error reading existing chat, creating new", {
          chatId: input.chatId,
          error: stringifyError(error),
        });
      }
    }

    const chat: Chat = {
      id: input.chatId,
      userId: input.userId,
      workspaceId: input.workspaceId,
      source: input.source,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messages: [],
    };

    await Deno.writeTextFile(chatFile, JSON.stringify(chat, null, 2));
    logger.debug("Created new chat", { chatId: input.chatId });

    return success(chat);
  } catch (error) {
    return fail(stringifyError(error));
  }
}

/**
 * Get chat by ID.
 *
 * Returns null if not found.
 * Returns error if corrupted (parse/validation fails).
 */
async function getChat(chatId: string): Promise<Result<Chat | null, string>> {
  try {
    const chat = await readAndValidateChat(getChatFile(chatId));
    return success(chat);
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") {
      return success(null);
    }
    if (error instanceof z.ZodError) {
      return fail(`Invalid chat data format: ${error.message}`);
    }
    return fail(stringifyError(error));
  }
}

/**
 * Append message to chat.
 *
 * Uses exclusive lock: only one writer at a time.
 * Lock sequence: read full chat → validate → append → write atomically.
 * Prevents lost writes on concurrent appends.
 */
async function appendMessage(
  chatId: string,
  message: AtlasUIMessage,
): Promise<Result<void, string>> {
  try {
    await ensureChatDir();
    const chatFile = getChatFile(chatId);

    using file = await Deno.open(chatFile, { read: true, write: true });
    await file.lock(true);

    const chat = await readAndValidateChat(chatFile);
    chat.messages.push(message);
    chat.updatedAt = new Date().toISOString();

    await Deno.writeTextFile(chatFile, JSON.stringify(chat, null, 2));

    return success(undefined);
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") {
      return fail("Chat not found");
    }
    if (error instanceof z.ZodError) {
      return fail(`Invalid chat data format: ${error.message}`);
    }
    return fail(stringifyError(error));
  }
}

interface ListChatsOptions {
  limit?: number;
  cursor?: number; // mtime timestamp - returns chats older than this
}

interface ListChatsResult {
  chats: Omit<Chat, "messages">[];
  nextCursor: number | null;
  hasMore: boolean;
}

/**
 * List most recently updated chats with cursor-based pagination.
 *
 * Reads mtime for all files, sorts by mtime descending.
 * When cursor provided, returns chats with mtime < cursor.
 * Returns chat metadata without messages for efficiency.
 */
async function listChats(options?: ListChatsOptions): Promise<Result<ListChatsResult, string>> {
  const limit = options?.limit ?? 25;
  const cursor = options?.cursor;

  try {
    await ensureChatDir();
    const chatDir = getChatDir();

    const fileInfos: Array<{ path: string; mtime: number }> = [];

    const chatEntries = await readdir(chatDir, { withFileTypes: true });
    for (const entry of chatEntries) {
      if (entry.isFile() && entry.name.endsWith(".json")) {
        const filePath = join(chatDir, entry.name);
        try {
          const stat = await Deno.stat(filePath);
          if (stat.mtime) {
            const mtime = stat.mtime.getTime();
            // Filter by cursor if provided
            if (cursor === undefined || mtime < cursor) {
              fileInfos.push({ path: filePath, mtime });
            }
          }
        } catch (error) {
          logger.warn("Failed to stat chat file, skipping", {
            file: entry.name,
            error: stringifyError(error),
          });
        }
      }
    }

    fileInfos.sort((a, b) => b.mtime - a.mtime);

    // Take limit + 1 to check if there are more
    const toRead = fileInfos.slice(0, limit + 1);
    const hasMore = toRead.length > limit;
    const filesToRead = toRead.slice(0, limit);

    const chats: Omit<Chat, "messages">[] = [];
    let lastMtime: number | null = null;

    for (const { path, mtime } of filesToRead) {
      try {
        const chat = await readAndValidateChat(path);
        const { messages: _, ...chatWithoutMessages } = chat;
        chats.push(chatWithoutMessages);
        lastMtime = mtime;
      } catch (error) {
        logger.warn("Failed to read chat file, skipping", { path, error: stringifyError(error) });
      }
    }

    return success({ chats, nextCursor: hasMore && lastMtime ? lastMtime : null, hasMore });
  } catch (error) {
    return fail(stringifyError(error));
  }
}

/**
 * Update chat title.
 *
 * Uses exclusive lock (same pattern as appendMessage).
 * Returns updated chat.
 */
async function updateChatTitle(chatId: string, title: string): Promise<Result<Chat, string>> {
  try {
    await ensureChatDir();
    const chatFile = getChatFile(chatId);

    using file = await Deno.open(chatFile, { read: true, write: true });
    await file.lock(true);

    const chat = await readAndValidateChat(chatFile);
    chat.title = title;
    chat.updatedAt = new Date().toISOString();

    await Deno.writeTextFile(chatFile, JSON.stringify(chat, null, 2));

    return success(chat);
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") {
      return fail("Chat not found");
    }
    if (error instanceof z.ZodError) {
      return fail(`Invalid chat data format: ${error.message}`);
    }
    return fail(stringifyError(error));
  }
}

/**
 * Delete chat by ID.
 *
 * Removes the chat file from disk.
 */
async function deleteChat(chatId: string): Promise<Result<void, string>> {
  try {
    const chatFile = getChatFile(chatId);
    await Deno.remove(chatFile);
    logger.debug("Deleted chat", { chatId });
    return success(undefined);
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") {
      return fail("Chat not found");
    }
    return fail(stringifyError(error));
  }
}

export const ChatStorage = {
  createChat,
  getChat,
  appendMessage,
  listChats,
  updateChatTitle,
  deleteChat,
};
