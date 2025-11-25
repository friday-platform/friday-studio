/**
 * Shared utilities for Discord integration.
 */

import type { AtlasUIMessage } from "@atlas/agent-sdk";
import { ChatStorage } from "@atlas/core/chat/storage";
import { logger } from "@atlas/logger";
import { fail, type Result } from "@atlas/utils";
import type { RESTPostAPIChannelMessageResult } from "@discordjs/core";
import { Routes } from "@discordjs/core";
import { REST } from "@discordjs/rest";
import { z } from "zod";
import type { DiscordSignalMetadata } from "./schemas.ts";

/**
 * Discord snowflake ID schema
 * Snowflakes are numeric strings (64-bit integers represented as strings)
 */
const DiscordSnowflakeSchema = z.string().regex(/^\d+$/, "Discord ID must be a numeric string");

/**
 * Create authenticated REST client for Discord API
 *
 * Centralizes REST client creation with token authentication.
 *
 * @param botToken - Discord bot token for authentication
 * @returns Configured REST client with authentication
 */
export function createAuthenticatedRestClient(botToken: string): REST {
  return new REST({ version: "10" }).setToken(botToken);
}

/**
 * Default workspace ID for Discord conversation routing
 * This workspace handles natural message conversations (DMs and @mentions)
 */
export const DISCORD_CONVERSATION_WORKSPACE_ID = "atlas-conversation";

/**
 * Generate deterministic chat ID for Discord conversations
 *
 * Uses SHA-256 hash of guild-channel-user to create persistent chat per user per channel.
 * Result is formatted as valid UUID v4 to pass existing validations.
 *
 * @param guildId - Discord server ID (null for DMs)
 * @param channelId - Discord channel ID
 * @param userId - Discord user ID
 * @returns UUID string that's consistent for same guild-channel-user combination
 */
export async function generateDiscordChatId(
  guildId: string | null,
  channelId: string,
  userId: string,
): Promise<string> {
  // Validate Discord snowflake IDs
  DiscordSnowflakeSchema.parse(channelId);
  DiscordSnowflakeSchema.parse(userId);
  if (guildId !== null) {
    DiscordSnowflakeSchema.parse(guildId);
  }

  const key = guildId
    ? `discord-${guildId}-${channelId}-${userId}`
    : `discord-dm-${channelId}-${userId}`;

  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  const bytes = new Uint8Array(hash);

  // Set UUID v4 version and variant bits
  // SHA-256 always produces exactly 32 bytes (cryptographic guarantee)
  // Non-null assertions are type-safe here - indices 6 and 8 always exist
  // biome-ignore lint/style/noNonNullAssertion: Type safety - SHA-256 spec guarantees 32-byte output
  bytes[6] = (bytes[6]! & 0x0f) | 0x40; // Version 4
  // biome-ignore lint/style/noNonNullAssertion: Type safety - SHA-256 spec guarantees 32-byte output
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // Variant 10

  // Convert first 16 bytes to hex and format as UUID
  const hex = Array.from(bytes.subarray(0, 16))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(
    16,
    20,
  )}-${hex.slice(20, 32)}`;
}

/**
 * Initialize chat and append user message
 *
 * @param chatId - Chat ID
 * @param userId - User ID
 * @param workspaceId - Workspace ID
 * @param messageText - User message text
 * @returns Result with success or error message
 */
export async function initializeDiscordChat(
  chatId: string,
  userId: string,
  workspaceId: string,
  messageText: string,
): Promise<Result<void, string>> {
  const createResult = await ChatStorage.createChat({ chatId, userId, workspaceId });

  if (!createResult.ok) {
    return fail(createResult.error);
  }

  const userMessage: AtlasUIMessage = {
    id: crypto.randomUUID(),
    role: "user",
    parts: [{ type: "text", text: messageText }],
  };

  const appendResult = await ChatStorage.appendMessage(chatId, userMessage);

  if (!appendResult.ok) {
    return fail(appendResult.error);
  }

  return { ok: true, data: undefined };
}

/**
 * Send message to Discord channel
 *
 * @param botToken - Bot token for authentication
 * @param channelId - Channel ID
 * @param content - Message content
 * @returns Discord message object from API
 */
export async function sendDiscordMessage(
  botToken: string,
  channelId: string,
  content: string,
): Promise<RESTPostAPIChannelMessageResult> {
  const rest = createAuthenticatedRestClient(botToken);

  try {
    // Using library's Result type for this endpoint (cast required - REST returns unknown)
    const response = (await rest.post(Routes.channelMessages(channelId), {
      body: { content },
    })) as RESTPostAPIChannelMessageResult;

    return response;
  } catch (error) {
    throw new Error(`Failed to send Discord message: ${error}`);
  }
}

/**
 * Update Discord interaction message
 *
 * Uses @discordjs/rest to edit the original interaction response
 * @param applicationId - Discord application ID
 * @param interactionToken - Interaction token
 * @param content - Message content
 */
export async function updateDiscordInteraction(
  applicationId: string,
  interactionToken: string,
  content: string,
): Promise<void> {
  const rest = new REST({ version: "10" }).setToken(interactionToken);

  try {
    await rest.patch(Routes.webhookMessage(applicationId, interactionToken, "@original"), {
      body: { content },
    });
  } catch (error) {
    logger.warn("Failed to update Discord interaction", { error });
  }
}

/**
 * Build Discord signal metadata from message
 *
 * @param message - Discord Gateway message object
 * @returns Structured metadata for signal payload
 */
export function buildDiscordMetadata(message: {
  id: string;
  channel_id: string;
  guild_id?: string | null;
  author: { id: string; username: string; discriminator: string };
  timestamp: string;
}): DiscordSignalMetadata {
  return {
    guildId: message.guild_id ?? null,
    channelId: message.channel_id,
    userId: message.author.id,
    username: message.author.username,
    discriminator: message.author.discriminator,
    timestamp: message.timestamp,
    interactionId: message.id,
    interactionToken: "",
  };
}
