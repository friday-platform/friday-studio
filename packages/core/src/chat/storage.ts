import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AtlasUIMessage } from "@atlas/agent-sdk";
import { validateAtlasUIMessages } from "@atlas/agent-sdk";
import { createLogger } from "@atlas/logger";
import {
  ColorSchema,
  fail,
  isErrnoException,
  type Result,
  randomColor,
  stringifyError,
  success,
} from "@atlas/utils";
import { getAtlasHome } from "@atlas/utils/paths.server";
import { z } from "zod";
import { withExclusiveLock } from "../utils/file-lock.ts";

const logger = createLogger({ component: "chat-storage" });

const SystemPromptContextSchema = z.object({
  timestamp: z.iso.datetime(),
  systemMessages: z.array(z.string()),
});

const ChatSourceSchema = z.enum(["atlas", "slack", "discord", "telegram", "whatsapp", "teams"]);
type ChatSource = z.infer<typeof ChatSourceSchema>;

/**
 * Chat structure on disk.
 * Messages validated separately via validateAtlasUIMessages (allows partial reads).
 */
const StoredChatSchema = z.object({
  id: z.string().min(1),
  userId: z.string().min(1),
  workspaceId: z.string().min(1),
  source: ChatSourceSchema,
  color: ColorSchema.optional(),
  title: z.string().optional(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  messages: z.array(z.unknown()),
  systemPromptContext: SystemPromptContextSchema.optional(),
  contentFilteredMessageIds: z.array(z.string()).optional(),
});

type Chat = Omit<z.infer<typeof StoredChatSchema>, "messages"> & { messages: AtlasUIMessage[] };

/** System workspace IDs that use global (non-prefixed) chat filenames */
const GLOBAL_WORKSPACE_IDS = new Set(["friday-conversation", "system"]);

/** Whether a workspaceId should use workspace-prefixed filenames */
function isWorkspaceScoped(workspaceId: string): boolean {
  return !GLOBAL_WORKSPACE_IDS.has(workspaceId);
}

/** Chats directory path */
function getChatDir(): string {
  return join(getAtlasHome(), "chats");
}

// POSIX NAME_MAX caps individual filename components at 255 bytes (APFS, ext4,
// tmpfs all enforce this). Teams thread IDs (base64 conv id + base64 service
// URL) routinely exceed 300 chars; any chatId whose `<id>.json` rendering
// exceeds the limit gets hashed. Using byte length — not `String#length`
// (UTF-16 code units) — so a future adapter emitting non-ASCII doesn't
// silently trip ENAMETOOLONG. The chat JSON body still carries the original
// id, so listing/reads only depend on this transform being deterministic.
const MAX_FILENAME_BYTES = 255;

function chatIdToFilename(chatId: string): string {
  const name = `${chatId}.json`;
  if (Buffer.byteLength(name, "utf8") <= MAX_FILENAME_BYTES) return name;
  const hash = createHash("sha256").update(chatId).digest("hex");
  return `_h_${hash}.json`;
}

function getChatFile(chatId: string, workspaceId?: string): string {
  const filename = chatIdToFilename(chatId);
  if (workspaceId && isWorkspaceScoped(workspaceId)) {
    return join(getChatDir(), workspaceId, filename);
  }
  return join(getChatDir(), filename);
}

/** Create chats directory (and workspace subdirectory) if missing */
async function ensureChatDir(workspaceId?: string): Promise<void> {
  const dir =
    workspaceId && isWorkspaceScoped(workspaceId) ? join(getChatDir(), workspaceId) : getChatDir();
  await mkdir(dir, { recursive: true });
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
  source: ChatSource;
}): Promise<Result<Chat, string>> {
  try {
    await ensureChatDir(input.workspaceId);
    const chatFile = getChatFile(input.chatId, input.workspaceId);

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
      color: randomColor(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messages: [],
    };

    await writeFile(chatFile, JSON.stringify(chat, null, 2), "utf-8");
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
async function getChat(chatId: string, workspaceId?: string): Promise<Result<Chat | null, string>> {
  try {
    const chat = await readAndValidateChat(getChatFile(chatId, workspaceId));
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
  workspaceId?: string,
): Promise<Result<void, string>> {
  try {
    await ensureChatDir(workspaceId);
    const chatFile = getChatFile(chatId, workspaceId);

    await withExclusiveLock(chatFile, async () => {
      const chat = await readAndValidateChat(chatFile);
      chat.messages.push(message);
      chat.updatedAt = new Date().toISOString();
      await writeFile(chatFile, JSON.stringify(chat, null, 2), "utf-8");
    });

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
 * List most recently updated global chats with cursor-based pagination.
 * Excludes workspace-prefixed chat files.
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
          const fileStat = await stat(filePath);
          if (fileStat.mtime) {
            const mtime = fileStat.mtime.getTime();
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
 * List chats for a specific workspace.
 * Reads from workspace subdirectory: chats/{workspaceId}/*.json
 */
async function listChatsByWorkspace(
  workspaceId: string,
  options?: ListChatsOptions,
): Promise<Result<ListChatsResult, string>> {
  const limit = options?.limit ?? 25;
  const cursor = options?.cursor;

  try {
    const wsDir = join(getChatDir(), workspaceId);
    await mkdir(wsDir, { recursive: true });

    const fileInfos: Array<{ path: string; mtime: number }> = [];

    const chatEntries = await readdir(wsDir, { withFileTypes: true });
    for (const entry of chatEntries) {
      if (entry.isFile() && entry.name.endsWith(".json")) {
        const filePath = join(wsDir, entry.name);
        try {
          const fileStat = await stat(filePath);
          if (fileStat.mtime) {
            const mtime = fileStat.mtime.getTime();
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
async function updateChatTitle(
  chatId: string,
  title: string,
  workspaceId?: string,
): Promise<Result<Chat, string>> {
  try {
    await ensureChatDir(workspaceId);
    const chatFile = getChatFile(chatId, workspaceId);

    const updatedChat = await withExclusiveLock(chatFile, async () => {
      const chat = await readAndValidateChat(chatFile);
      chat.title = title;
      chat.updatedAt = new Date().toISOString();
      await writeFile(chatFile, JSON.stringify(chat, null, 2), "utf-8");
      return chat;
    });

    return success(updatedChat);
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
async function deleteChat(chatId: string, workspaceId?: string): Promise<Result<void, string>> {
  try {
    const chatFile = getChatFile(chatId, workspaceId);
    await rm(chatFile);
    logger.debug("Deleted chat", { chatId });
    return success(undefined);
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") {
      return fail("Chat not found");
    }
    return fail(stringifyError(error));
  }
}

/**
 * Set system prompt context. Idempotent - only writes on first call.
 * Called from conversation agent on first turn.
 */
async function setSystemPromptContext(
  chatId: string,
  context: { systemMessages: string[] },
  workspaceId?: string,
): Promise<Result<void, string>> {
  try {
    const chatFile = getChatFile(chatId, workspaceId);

    await withExclusiveLock(chatFile, async () => {
      const chat = await readAndValidateChat(chatFile);
      if (chat.systemPromptContext) {
        return; // Already set, skip
      }
      chat.systemPromptContext = { timestamp: new Date().toISOString(), ...context };
      chat.updatedAt = new Date().toISOString();
      await writeFile(chatFile, JSON.stringify(chat, null, 2), "utf-8");
    });
    return success(undefined);
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") {
      return fail("Chat not found");
    }
    return fail(stringifyError(error));
  }
}

/**
 * Mark messages as content-filtered. Appends to existing set, deduplicates.
 * Uses exclusive lock (same pattern as appendMessage).
 */
async function addContentFilteredMessageIds(
  chatId: string,
  messageIds: string[],
  workspaceId?: string,
): Promise<Result<void, string>> {
  try {
    await ensureChatDir(workspaceId);
    const chatFile = getChatFile(chatId, workspaceId);

    await withExclusiveLock(chatFile, async () => {
      const chat = await readAndValidateChat(chatFile);
      const existing = new Set(chat.contentFilteredMessageIds ?? []);
      for (const id of messageIds) {
        existing.add(id);
      }
      chat.contentFilteredMessageIds = [...existing];
      chat.updatedAt = new Date().toISOString();
      await writeFile(chatFile, JSON.stringify(chat, null, 2), "utf-8");
    });
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
  listChatsByWorkspace,
  updateChatTitle,
  deleteChat,
  setSystemPromptContext,
  addContentFilteredMessageIds,
};
