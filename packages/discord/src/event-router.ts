/**
 * Routes Discord Gateway events to workspace signals based on event configuration.
 */

import type { DiscordSignalRegistrar } from "@atlas/discord";
import { logger } from "@atlas/logger";
import type { WorkspaceSignalTriggerCallback } from "@atlas/workspace/types";
import {
  GatewayDispatchEvents,
  type GatewayMessageCreateDispatchData,
  type GatewayMessageUpdateDispatchData,
} from "@discordjs/core";
import type { DiscordConversationHandler } from "./conversation.ts";
import type { GatewayEvent } from "./gateway.ts";
import { buildDiscordMetadata, DISCORD_CONVERSATION_WORKSPACE_ID } from "./utils.ts";

/**
 * Type guard: Check if UPDATE message has complete data
 *
 * MESSAGE_UPDATE events can have partial data (author, content, mentions are optional).
 * After runtime validation, we know the message is complete and can treat it as CREATE data.
 *
 * TypeScript cannot infer this from null checks alone, so we use a type predicate.
 */
function hasCompleteMessageData(
  message: GatewayMessageUpdateDispatchData,
): message is GatewayMessageCreateDispatchData {
  return (
    message.author !== undefined && message.content !== undefined && message.mentions !== undefined
  );
}

/**
 * Routes Gateway events to signals with filtering by DM, @mention, and guild channels.
 *
 * Special case: atlas-conversation workspace uses DiscordConversationHandler for
 * responses with Discord UX features (typing indicators, response accumulation, auto-delivery).
 * Regular workspaces should use Discord MCP tools for custom interactions.
 */
export class DiscordEventRouter {
  constructor(
    private readonly signalRegistrar: DiscordSignalRegistrar,
    private readonly onWakeup: WorkspaceSignalTriggerCallback,
    private readonly applicationId: string,
    private readonly conversationHandler: DiscordConversationHandler,
  ) {}

  /**
   * Route Gateway event to signals
   *
   * @param event - Typed Gateway event from Discord
   */
  async routeEvent(event: GatewayEvent): Promise<void> {
    try {
      if (event.type === GatewayDispatchEvents.MessageCreate) {
        await this.handleMessageCreate(event.data);
      } else if (event.type === GatewayDispatchEvents.MessageUpdate) {
        await this.handleMessageUpdate(event.data);
      }
    } catch (error) {
      logger.error("Failed to route Discord event", { eventType: event.type, error });
    }
  }

  /**
   * Handle MESSAGE_CREATE event
   * MESSAGE_CREATE always has complete data (author, content, mentions)
   */
  private async handleMessageCreate(message: GatewayMessageCreateDispatchData): Promise<void> {
    try {
      if (message.author.bot) {
        return;
      }

      const isDM = !message.guild_id;
      const isMention = message.mentions.some((m: { id: string }) => m.id === this.applicationId);

      const matches = this.signalRegistrar.getMatchingSignals({
        eventType: "message_create",
        isDM,
        isMention,
        guildId: message.guild_id ?? null,
      });

      if (matches.length === 0) {
        return;
      }

      logger.info("Triggering Discord signals from message", {
        messageId: message.id,
        matchCount: matches.length,
        isDM,
        isMention,
      });

      // Route to appropriate handler
      // atlas-conversation: response accumulation with Discord UX (typing, auto-delivery)
      // Other workspaces: fire-and-forget signal trigger
      for (const { workspaceId, signalId } of matches) {
        if (workspaceId === DISCORD_CONVERSATION_WORKSPACE_ID) {
          await this.conversationHandler.handle(message);
        } else {
          await this.triggerSignal(workspaceId, signalId, message);
        }
      }
    } catch (error) {
      logger.error("Failed to handle MESSAGE_CREATE event", { error, messageId: message.id });
    }
  }

  /**
   * Handle MESSAGE_UPDATE event
   * MESSAGE_UPDATE may have partial data - only process if complete
   */
  private async handleMessageUpdate(message: GatewayMessageUpdateDispatchData): Promise<void> {
    try {
      // Skip if missing essential fields (UPDATE events can be partial)
      if (!hasCompleteMessageData(message)) {
        return;
      }

      // TypeScript now knows message has all required fields
      if (message.author.bot) {
        return;
      }

      const isDM = !message.guild_id;
      const isMention = message.mentions.some((m: { id: string }) => m.id === this.applicationId);

      const matches = this.signalRegistrar.getMatchingSignals({
        eventType: "message_update",
        isDM,
        isMention,
        guildId: message.guild_id ?? null,
      });

      if (matches.length === 0) {
        return;
      }

      logger.info("Triggering Discord signals from message update", {
        messageId: message.id,
        matchCount: matches.length,
      });

      // message is now typed as GatewayMessageCreateDispatchData - no cast needed
      for (const { workspaceId, signalId } of matches) {
        await this.triggerSignal(workspaceId, signalId, message);
      }
    } catch (error) {
      logger.error("Failed to handle MESSAGE_UPDATE event", { error, messageId: message.id });
    }
  }

  /**
   * Trigger workspace signal with Discord message payload
   *
   * Fire-and-forget signal trigger. Workspace controls if/how to respond.
   * For Discord responses, workspace should use Discord MCP tools.
   */
  private async triggerSignal(
    workspaceId: string,
    signalId: string,
    message: GatewayMessageCreateDispatchData,
  ): Promise<void> {
    try {
      const discordMetadata = buildDiscordMetadata(message);

      const payload = { message: message.content, _discord: discordMetadata };

      await this.onWakeup(workspaceId, signalId, payload);
    } catch (error) {
      logger.error("Failed to trigger Discord signal", {
        workspaceId,
        signalId,
        messageId: message.id,
        error,
      });
    }
  }
}
