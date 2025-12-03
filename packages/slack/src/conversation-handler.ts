/**
 * Handles streaming conversations for the atlas-conversation system workspace.
 *
 * This is privileged infrastructure for natural Slack messaging.
 * User workspaces should use Slack MCP tools for custom Slack interactions.
 */

import type { AtlasUIMessageChunk } from "@atlas/agent-sdk";
import { logger } from "@atlas/logger";
import type { WebClient } from "@slack/web-api";
import type { SlackSignalPayload } from "./schemas.ts";
import {
  generateSlackChatId,
  initializeSlackChat,
  SLACK_CONVERSATION_WORKSPACE_ID,
  sendSlackMessage,
} from "./utils.ts";

/**
 * Interface for daemon's signal triggering capability
 * Matches Discord's DaemonSignalTrigger interface
 */
export interface DaemonSignalTrigger {
  triggerWorkspaceSignal(
    workspaceId: string,
    signalId: string,
    payload?: Record<string, unknown>,
    streamId?: string,
    onStreamEvent?: (chunk: AtlasUIMessageChunk) => void,
  ): Promise<{ sessionId: string }>;

  waitForSignalCompletion(
    workspaceId: string,
    sessionId: string,
    timeoutMs?: number,
  ): Promise<boolean>;
}

/**
 * Handles streaming conversation responses for the atlas-conversation workspace.
 *
 * This class provides Slack-specific UX features:
 * - Persistent chat history with deterministic IDs
 * - Streaming response accumulation
 * - Automatic response delivery to Slack
 *
 * Regular user workspaces should use Slack MCP tools for custom interactions.
 */
export class SlackConversationHandler {
  private readonly slackClient: WebClient;
  public readonly conversationWorkspaceId: string;

  constructor(
    boltClient: WebClient,
    private readonly daemon: DaemonSignalTrigger,
  ) {
    this.slackClient = boltClient;
    this.conversationWorkspaceId = SLACK_CONVERSATION_WORKSPACE_ID;
  }

  /**
   * Handle conversation for atlas-conversation workspace
   *
   * This method orchestrates the complete conversation flow:
   * 1. Generate deterministic chat ID for history persistence
   * 2. Initialize chat in storage with user message
   * 3. Stream conversation response and accumulate text
   * 4. Send final response to Slack
   *
   * @param payload - Slack message payload
   */
  async handleMessage(payload: SlackSignalPayload): Promise<void> {
    try {
      // Validate required fields
      if (!payload.userId) {
        logger.error("Message missing userId, cannot create chat", {
          messageId: payload.messageId,
        });
        return;
      }

      if (!payload.teamId) {
        logger.error("Message missing teamId, cannot create chat", {
          messageId: payload.messageId,
        });
        return;
      }

      // Generate deterministic chat ID (same user+channel = same chat)
      const chatId = await generateSlackChatId(payload.teamId, payload.channelId, payload.userId);

      // Initialize chat with user message
      const chatResult = await initializeSlackChat(
        chatId,
        payload.userId,
        SLACK_CONVERSATION_WORKSPACE_ID,
        payload.text,
      );

      if (!chatResult.ok) {
        logger.error("Failed to initialize chat", { reason: chatResult.error });
        return;
      }

      // Accumulate response text during streaming
      let responseText = "";

      // Trigger conversation-stream signal with streaming callback
      const { sessionId } = await this.daemon.triggerWorkspaceSignal(
        SLACK_CONVERSATION_WORKSPACE_ID,
        "conversation-stream",
        {
          message: payload.text,
          userId: payload.userId,
          _slack: {
            channelId: payload.channelId,
            channelType: payload.channelType,
            messageId: payload.messageId,
            threadTs: payload.threadTs,
            teamId: payload.teamId,
            userId: payload.userId,
          },
        },
        chatId,
        (chunk: AtlasUIMessageChunk) => {
          if (chunk.type === "text-delta") {
            responseText += chunk.delta;
          }
        },
      );

      // Wait for conversation to complete before sending response
      const completed = await this.daemon.waitForSignalCompletion(
        SLACK_CONVERSATION_WORKSPACE_ID,
        sessionId,
      );

      // Send response based on completion status and content
      if (responseText.trim()) {
        // We have content - send it regardless of completion status
        await sendSlackMessage(this.slackClient, payload.channelId, responseText, payload.threadTs);

        if (completed) {
          logger.info("Slack conversation completed successfully", {
            chatId,
            messageId: payload.messageId,
          });
        } else {
          // Send follow-up indicating incomplete response
          logger.warn("Slack conversation incomplete - sending partial response", {
            chatId,
            messageId: payload.messageId,
          });
          await sendSlackMessage(
            this.slackClient,
            payload.channelId,
            "_[Response may be incomplete - session did not complete successfully]_",
            payload.threadTs,
          );
        }
      } else if (!completed) {
        // No content and session failed - send error message
        logger.error("Slack conversation failed with no response", {
          chatId,
          messageId: payload.messageId,
        });
        await sendSlackMessage(
          this.slackClient,
          payload.channelId,
          "_Sorry, I encountered an error processing your message._",
          payload.threadTs,
        );
      } else {
        // Session completed but produced no output - unusual but not an error
        logger.warn("Slack conversation completed with no response text", {
          chatId,
          messageId: payload.messageId,
        });
      }
    } catch (error) {
      logger.error("Failed to handle conversation", { error, messageId: payload.messageId });
    }
  }
}
