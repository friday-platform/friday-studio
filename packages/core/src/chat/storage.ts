import type { AtlasUIMessage } from "@atlas/agent-sdk";
import { validateAtlasUIMessages } from "@atlas/agent-sdk";
import { createLogger } from "@atlas/logger";
import { fail, type Result, stringifyError, success } from "@atlas/utils";
import { getAtlasHome } from "@atlas/utils/paths.server";
import { join } from "@std/path";
import { z } from "zod";

const logger = createLogger({ component: "chat-storage" });

// Zod schema for validating stored chat data
// Messages are validated at API boundary before storage, so we trust the stored format
const StoredChatSchema = z.object({
  id: z.uuid(),
  userId: z.string().min(1),
  workspaceId: z.string().min(1),
  title: z.string().optional(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  messages: z.array(z.unknown()), // Validated before storage, trust stored data
});

// Override messages type to AtlasUIMessage[] since we validate at API boundary
type Chat = Omit<z.infer<typeof StoredChatSchema>, "messages"> & { messages: AtlasUIMessage[] };

function getChatDir(): string {
  return join(getAtlasHome(), "chats");
}

function getChatFile(chatId: string): string {
  return join(getChatDir(), `${chatId}.json`);
}

async function ensureChatDir(): Promise<void> {
  await Deno.mkdir(getChatDir(), { recursive: true });
}

async function readAndValidateChat(filePath: string): Promise<Chat> {
  const content = await Deno.readTextFile(filePath);
  const json = JSON.parse(content);
  const parsedChat = StoredChatSchema.parse(json);
  const messages = await validateAtlasUIMessages(parsedChat.messages);
  return { ...parsedChat, messages };
}

/** Create chat */
async function createChat(input: {
  chatId: string;
  userId: string;
  workspaceId: string;
}): Promise<Result<Chat, string>> {
  try {
    await ensureChatDir();

    const chat: Chat = {
      id: input.chatId,
      userId: input.userId,
      workspaceId: input.workspaceId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messages: [],
    };

    const chatFile = getChatFile(input.chatId);
    await Deno.writeTextFile(chatFile, JSON.stringify(chat, null, 2));

    return success(chat);
  } catch (error) {
    return fail(stringifyError(error));
  }
}

/** Get chat by ID */
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

/** Append message to chat (with file locking to prevent race conditions) */
async function appendMessage(
  chatId: string,
  message: AtlasUIMessage,
): Promise<Result<void, string>> {
  try {
    await ensureChatDir();
    const chatFile = getChatFile(chatId);

    // Lock the actual chat file, auto-releases with 'using'
    using file = await Deno.open(chatFile, { read: true, write: true });
    await file.lock(true);

    // Read current content
    const chat = await readAndValidateChat(chatFile);

    // Append and write back
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
 * List recent chats, sorted by most recently updated.
 * Optimized to only read metadata from top N files by mtime.
 */
async function listChats(limit = 5): Promise<Result<Chat[], string>> {
  try {
    await ensureChatDir();
    const chatDir = getChatDir();

    // Collect file paths with their modification times
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

    // Sort by mtime descending (newest first)
    fileInfos.sort((a, b) => b.mtime - a.mtime);

    // Read only top N files
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

/** Update chat title (with file locking to prevent race conditions) */
async function updateChatTitle(chatId: string, title: string): Promise<Result<Chat, string>> {
  try {
    await ensureChatDir();
    const chatFile = getChatFile(chatId);

    // Lock the actual chat file, auto-releases with 'using'
    using file = await Deno.open(chatFile, { read: true, write: true });
    await file.lock(true);

    // Read current content
    const chat = await readAndValidateChat(chatFile);

    // Update and write back
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
