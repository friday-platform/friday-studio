/**
 * Chat storage facade.
 *
 * The implementation is JetStream-backed (see jetstream-backend.ts). This file
 * keeps the legacy `ChatStorage.*` import shape stable so callers don't move.
 *
 * `initChatStorage(nc)` must be called once at daemon startup before any
 * `ChatStorage.*` call.
 */

import type { AtlasUIMessage } from "@atlas/agent-sdk";
import type { Result } from "@atlas/utils";
import type { NatsConnection } from "nats";
import {
  type Chat,
  type ChatStreamLimits,
  createJetStreamChatBackend,
  ensureChatsKVBucket,
  type JetStreamChatBackend,
} from "./jetstream-backend.ts";

export type { Chat };
export { ensureChatsKVBucket };

let backend: JetStreamChatBackend | null = null;

export function initChatStorage(nc: NatsConnection, limits: ChatStreamLimits = {}): void {
  backend = createJetStreamChatBackend(nc, limits);
}

function b(): JetStreamChatBackend {
  if (!backend) {
    throw new Error("ChatStorage not initialized — call initChatStorage(nc) at daemon startup");
  }
  return backend;
}

/**
 * Legacy "global" chats — those without a workspace-prefixed file path.
 * Both `undefined` and these system workspaceIds collapse to one key prefix
 * so callers can find a chat created via `workspaceId: "friday-conversation"`
 * via `getChat(id)` (the legacy global lookup path).
 */
const GLOBAL_WORKSPACE_IDS = new Set(["friday-conversation", "system"]);
const GLOBAL_KEY = "_global";

function resolveWorkspaceId(workspaceId: string | undefined): string {
  if (!workspaceId || GLOBAL_WORKSPACE_IDS.has(workspaceId)) return GLOBAL_KEY;
  return workspaceId;
}

interface ListChatsOptions {
  limit?: number;
  cursor?: number;
}

interface ChatSourceInput {
  chatId: string;
  userId: string;
  workspaceId: string;
  source: "atlas" | "slack" | "discord" | "telegram" | "whatsapp" | "teams";
}

function createChat(input: ChatSourceInput): Promise<Result<Chat, string>> {
  return b().createChat({ ...input, workspaceId: resolveWorkspaceId(input.workspaceId) });
}

function getChat(chatId: string, workspaceId?: string): Promise<Result<Chat | null, string>> {
  return b().getChat(chatId, resolveWorkspaceId(workspaceId));
}

function appendMessage(
  chatId: string,
  message: AtlasUIMessage,
  workspaceId?: string,
): Promise<Result<void, string>> {
  return b().appendMessage(chatId, message, resolveWorkspaceId(workspaceId));
}

function listChats(opts?: ListChatsOptions) {
  return b().listChats(opts);
}

function listChatsByWorkspace(workspaceId: string, opts?: ListChatsOptions) {
  return b().listChatsByWorkspace(resolveWorkspaceId(workspaceId), opts);
}

function updateChatTitle(
  chatId: string,
  title: string,
  workspaceId?: string,
): Promise<Result<Chat, string>> {
  return b().updateChatTitle(chatId, title, resolveWorkspaceId(workspaceId));
}

function deleteChat(chatId: string, workspaceId?: string): Promise<Result<void, string>> {
  return b().deleteChat(chatId, resolveWorkspaceId(workspaceId));
}

function setSystemPromptContext(
  chatId: string,
  context: { systemMessages: string[] },
  workspaceId?: string,
): Promise<Result<void, string>> {
  return b().setSystemPromptContext(chatId, context, resolveWorkspaceId(workspaceId));
}

function addContentFilteredMessageIds(
  chatId: string,
  messageIds: string[],
  workspaceId?: string,
): Promise<Result<void, string>> {
  return b().addContentFilteredMessageIds(chatId, messageIds, resolveWorkspaceId(workspaceId));
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
