/**
 * Slack utility functions for chat management
 */

import type { AtlasUIMessage } from "@atlas/agent-sdk";
import { ChatStorage } from "@atlas/core/chat/storage";
import type { WebClient } from "@slack/web-api";

/**
 * System workspace ID for Slack conversational AI.
 *
 * This is privileged infrastructure that provides natural conversation
 * capabilities via Slack. It handles:
 * - Deterministic chat ID generation for history persistence
 * - Streaming response accumulation
 * - Automatic message delivery to Slack channels
 *
 * Regular user workspaces should use Slack MCP tools for custom interactions.
 */
export const SLACK_CONVERSATION_WORKSPACE_ID = "atlas-conversation";

/**
 * Generate deterministic chat ID for Slack conversations
 *
 * Uses SHA-256 hash of team+channel+user to create RFC 4122 v4 compliant UUIDs.
 * This ensures the same conversation always has the same ID, enabling
 * persistent chat history across sessions.
 */
export async function generateSlackChatId(
  teamId: string,
  channelId: string,
  userId: string,
): Promise<string> {
  const key = `slack-${teamId}-${channelId}-${userId}`;
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  const bytes = new Uint8Array(hash);

  // SHA-256 always produces 32 bytes - verify invariant
  if (bytes.length !== 32) {
    throw new Error(`Invalid hash length: expected 32, got ${bytes.length}`);
  }

  // Set UUID v4 variant and version bits (RFC 4122 section 4.4)
  // Extract values to satisfy type checker (length check guarantees these exist)
  const byte6 = bytes[6];
  const byte8 = bytes[8];
  if (byte6 === undefined || byte8 === undefined) {
    throw new Error("Invalid hash byte access");
  }
  bytes[6] = (byte6 & 0x0f) | 0x40; // Version 4
  bytes[8] = (byte8 & 0x3f) | 0x80; // Variant 10xx

  // Convert first 16 bytes to UUID format (8-4-4-4-12)
  const hex = Array.from(bytes.slice(0, 16), (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Initialize chat and append user message
 */
export async function initializeSlackChat(
  chatId: string,
  userId: string,
  workspaceId: string,
  messageText: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const createResult = await ChatStorage.createChat({ chatId, userId, workspaceId });

  if (!createResult.ok) {
    return { ok: false, error: createResult.error };
  }

  const userMessage: AtlasUIMessage = {
    id: crypto.randomUUID(),
    role: "user",
    parts: [{ type: "text", text: messageText }],
  };

  const appendResult = await ChatStorage.appendMessage(chatId, userMessage);

  if (!appendResult.ok) {
    return { ok: false, error: appendResult.error };
  }

  return { ok: true };
}

/**
 * Send message to Slack channel using provided WebClient
 *
 * @throws Error if message sending fails (permissions, rate limits, invalid channel, etc.)
 */
export async function sendSlackMessage(
  client: WebClient,
  channelId: string,
  content: string,
  threadTs?: string,
): Promise<void> {
  try {
    await client.chat.postMessage({ channel: channelId, text: content, thread_ts: threadTs });
  } catch (error) {
    // Re-throw with context for better debugging
    throw new Error(
      `Failed to send Slack message to channel ${channelId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }
}
