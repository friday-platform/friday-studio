/**
 * Platform utilities for Slack integration.
 *
 * Migrated from packages/slack for gateway compatibility.
 * These utils maintain deterministic chat IDs for conversation history.
 */

import type { AtlasUIMessage } from "@atlas/agent-sdk";
import type { Result } from "@atlas/utils";

function toHex(buffer: Uint8Array): string {
  return Array.from(buffer)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Generate deterministic Slack chat ID
 *
 * Formula: SHA-256(team_id:channel_id:user_id)
 *
 * Same user+channel+team = same chat ID = persistent history
 */
export async function generateSlackChatId(
  teamId: string,
  channelId: string,
  userId: string,
): Promise<string> {
  const input = `${teamId}:${channelId}:${userId}`;
  const encoder = new TextEncoder();
  const data = encoder.encode(input);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return toHex(new Uint8Array(hashBuffer));
}

/**
 * Initialize chat storage for platform conversations
 *
 * Creates chat record if it doesn't exist, appends user message to history.
 *
 * @param chatId - Deterministic chat ID
 * @param userId - User identifier
 * @param workspaceId - Workspace handling this chat
 * @param userMessage - User's message text
 * @param source - Platform source (slack or discord)
 */
export async function initializePlatformChat(
  chatId: string,
  userId: string,
  workspaceId: string,
  userMessage: string,
  source: "slack" | "discord",
): Promise<Result<void, string>> {
  const { ChatStorage } = await import("@atlas/core/chat/storage");

  // Create or get existing chat (idempotent)
  const createResult = await ChatStorage.createChat({ chatId, userId, workspaceId, source });

  if (!createResult.ok) {
    return createResult;
  }

  // Append user message to history
  const message: AtlasUIMessage = {
    id: crypto.randomUUID(),
    role: "user",
    parts: [{ type: "text", text: userMessage }],
  };

  const appendResult = await ChatStorage.appendMessage(chatId, message);

  return appendResult;
}
