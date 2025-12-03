/**
 * Discord conversation handling with response accumulation for atlas-conversation system workspace.
 *
 * This is privileged infrastructure for natural Discord messaging.
 * User workspaces should use Discord MCP tools for custom Discord interactions.
 */

import type { AtlasUIMessageChunk } from "@atlas/agent-sdk";
import { logger } from "@atlas/logger";
import type { Result } from "@atlas/utils";
import { type GatewayMessageCreateDispatchData, Routes } from "@discordjs/core";
import type { REST } from "@discordjs/rest";
import type { DaemonSignalTrigger } from "./integration.ts";
import {
  buildDiscordMetadata,
  createAuthenticatedRestClient,
  DISCORD_CONVERSATION_WORKSPACE_ID,
  generateDiscordChatId,
  initializeDiscordChat,
  sendDiscordMessage,
} from "./utils.ts";

/**
 * Discord typing indicator duration (10 seconds)
 * Typing indicator lasts 10s, refresh every 8s to keep it active
 */
const TYPING_INDICATOR_REFRESH_MS = 8000;

/**
 * Options for running a Discord conversation
 */
export interface ConversationOptions {
  /** User message text */
  message: string;
  /** User ID for chat history */
  userId: string;
  /** Guild ID (null for DMs) */
  guildId: string | null;
  /** Channel ID */
  channelId: string;
  /** Optional pre-generated chat ID (avoids recalculation) */
  chatId?: string;
  /** Additional signal payload metadata */
  additionalPayload?: Record<string, unknown>;
}

/**
 * Successful conversation result data
 */
export interface ConversationData {
  /** Accumulated response text */
  responseText: string;
  /** Chat ID used for this conversation */
  chatId: string;
}

/**
 * Failed conversation error data
 */
export interface ConversationErrorData {
  /** Error message */
  error: string;
  /** Chat ID if available */
  chatId?: string;
}

/**
 * Run a Discord conversation with response accumulation.
 *
 * This function:
 * 1. Generates deterministic chat ID for history persistence
 * 2. Initializes chat record with user message
 * 3. Triggers conversation-stream signal
 * 4. Accumulates response text (no real-time updates)
 * 5. Waits for completion
 * 6. Returns accumulated response
 *
 * Callers are responsible for:
 * - Sending the response to Discord (typing indicators, message edits, etc.)
 * - Adding UI elements (buttons, etc.)
 *
 * @param daemon - Daemon signal trigger interface
 * @param options - Conversation options
 * @returns Result with accumulated response text or error
 */
export async function runDiscordConversation(
  daemon: DaemonSignalTrigger,
  options: ConversationOptions,
): Promise<Result<ConversationData, ConversationErrorData>> {
  try {
    // Use provided chatId or generate deterministic one (same user+channel = same chat)
    const chatId =
      options.chatId ??
      (await generateDiscordChatId(options.guildId, options.channelId, options.userId));

    // Initialize chat with user message
    const chatResult = await initializeDiscordChat(
      chatId,
      options.userId,
      DISCORD_CONVERSATION_WORKSPACE_ID,
      options.message,
    );

    if (!chatResult.ok) {
      logger.error("Failed to initialize chat", { reason: chatResult.error, chatId });
      return { ok: false, error: { error: chatResult.error, chatId } };
    }

    // Accumulate response text during signal processing
    let responseText = "";

    // Trigger conversation-stream signal with accumulation callback
    const { sessionId } = await daemon.triggerWorkspaceSignal(
      DISCORD_CONVERSATION_WORKSPACE_ID,
      "conversation-stream",
      { message: options.message, userId: options.userId, ...options.additionalPayload },
      chatId,
      (chunk: AtlasUIMessageChunk) => {
        if (chunk.type === "text-delta") {
          responseText += chunk.delta;
        }
      },
    );

    // Wait for conversation to complete
    const completed = await daemon.waitForSignalCompletion(
      DISCORD_CONVERSATION_WORKSPACE_ID,
      sessionId,
    );

    if (!completed) {
      logger.error("Discord conversation failed or timed out", {
        chatId,
        userId: options.userId,
        sessionId,
      });
      return { ok: false, error: { error: "Conversation processing failed or timed out", chatId } };
    }

    logger.info("Discord conversation completed", {
      chatId,
      userId: options.userId,
      responseLength: responseText.length,
    });

    return { ok: true, data: { responseText, chatId } };
  } catch (error) {
    logger.error("Discord conversation failed", { error, userId: options.userId });
    return { ok: false, error: { error: error instanceof Error ? error.message : String(error) } };
  }
}

/**
 * Handles conversation responses for the atlas-conversation workspace.
 *
 * This class provides Discord-specific UX features:
 * - Typing indicators during processing
 * - Persistent chat history with deterministic IDs
 * - Response accumulation (responses collected in memory, sent once)
 * - Automatic response delivery to Discord
 *
 * Regular user workspaces should use Discord MCP tools for custom interactions.
 */
export class DiscordConversationHandler {
  private readonly rest: REST;
  private readonly botToken: string;

  constructor(
    botToken: string,
    private readonly daemon: DaemonSignalTrigger,
  ) {
    this.botToken = botToken;
    this.rest = createAuthenticatedRestClient(botToken);
  }

  /**
   * Handle conversation for atlas-conversation workspace
   *
   * This method orchestrates the complete conversation flow:
   * 1. Generate deterministic chat ID for history persistence
   * 2. Initialize chat in storage with user message
   * 3. Show typing indicator while processing
   * 4. Accumulate conversation response text
   * 5. Send final response to Discord
   *
   * @param message - Discord message that triggered the conversation
   */
  async handle(message: GatewayMessageCreateDispatchData): Promise<void> {
    let typingInterval: ReturnType<typeof setInterval> | undefined;

    try {
      // Start typing indicator
      await this.sendTypingIndicator(message.channel_id);

      // Keep typing indicator alive during processing
      typingInterval = setInterval(() => {
        this.sendTypingIndicator(message.channel_id).catch((err) =>
          logger.debug("Typing indicator failed", { err, channelId: message.channel_id }),
        );
      }, TYPING_INDICATOR_REFRESH_MS);

      // Build Discord metadata for signal payload
      const discordMetadata = buildDiscordMetadata(message);

      // Run conversation with response accumulation
      const result = await runDiscordConversation(this.daemon, {
        message: message.content,
        userId: message.author.id,
        guildId: message.guild_id || null,
        channelId: message.channel_id,
        additionalPayload: { _discord: discordMetadata },
      });

      if (result.ok) {
        // Send accumulated response to Discord
        await sendDiscordMessage(
          this.botToken,
          message.channel_id,
          result.data.responseText || "_(No response)_",
        );

        logger.info("Discord conversation completed", {
          chatId: result.data.chatId,
          messageId: message.id,
        });
      } else {
        logger.error("Failed to run conversation", {
          chatId: result.error.chatId,
          error: result.error.error,
          messageId: message.id,
        });
      }
    } catch (error) {
      logger.error("Failed to handle conversation", { error, messageId: message.id });
    } finally {
      // Always clear typing indicator interval to prevent resource leak
      if (typingInterval) {
        clearInterval(typingInterval);
      }
    }
  }

  /**
   * Send typing indicator to Discord channel
   *
   * Shows "... is typing" indicator for 10 seconds.
   * Call repeatedly to keep indicator active during long operations.
   *
   * @see https://discord.com/developers/docs/resources/channel#trigger-typing-indicator
   */
  private async sendTypingIndicator(channelId: string): Promise<void> {
    try {
      await this.rest.post(Routes.channelTyping(channelId));
    } catch (error) {
      logger.debug("Error sending typing indicator", { error, channelId });
    }
  }
}
