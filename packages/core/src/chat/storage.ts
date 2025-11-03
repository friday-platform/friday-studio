import type { AtlasUIMessage } from "@atlas/agent-sdk";
import { validateAtlasUIMessages } from "@atlas/agent-sdk";
import { createLogger } from "@atlas/logger";
import { fail, type Result, stringifyError, success } from "@atlas/utils";
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
  await Deno.mkdir(getChatDir(), { recursive: true });
}

/**
 * Read + validate chat from disk.
 * Throws: file not found, JSON parse error, schema validation error, message validation error
 */
async function readAndValidateChat(filePath: string): Promise<Chat> {
  const content = await Deno.readTextFile(filePath);
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
      if (!(error instanceof Deno.errors.NotFound)) {
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
    if (error instanceof Deno.errors.NotFound) {
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
    if (error instanceof Deno.errors.NotFound) {
      return fail("Chat not found");
    }
    if (error instanceof z.ZodError) {
      return fail(`Invalid chat data format: ${error.message}`);
    }
    return fail(stringifyError(error));
  }
}

/**
 * List N most recently updated chats.
 *
 * Reads mtime for all files, sorts by mtime descending, fully reads only top N.
 * Gracefully skips corrupted chats (logs warning).
 */
async function listChats(limit = 5): Promise<Result<Chat[], string>> {
  try {
    await ensureChatDir();
    const chatDir = getChatDir();

    const fileInfos: Array<{ path: string; mtime: number }> = [];

    for await (const entry of Deno.readDir(chatDir)) {
      if (entry.isFile && entry.name.endsWith(".json")) {
        const filePath = join(chatDir, entry.name);
        try {
          const stat = await Deno.stat(filePath);
          if (stat.mtime) {
            fileInfos.push({ path: filePath, mtime: stat.mtime.getTime() });
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

    const chats: Chat[] = [];
    for (const { path } of fileInfos.slice(0, limit)) {
      try {
        chats.push(await readAndValidateChat(path));
      } catch (error) {
        logger.warn("Failed to read chat file, skipping", { path, error: stringifyError(error) });
      }
    }

    return success(chats);
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
    if (error instanceof Deno.errors.NotFound) {
      return fail("Chat not found");
    }
    if (error instanceof z.ZodError) {
      return fail(`Invalid chat data format: ${error.message}`);
    }
    return fail(stringifyError(error));
  }
}

export const ChatStorage = { createChat, getChat, appendMessage, listChats, updateChatTitle };
