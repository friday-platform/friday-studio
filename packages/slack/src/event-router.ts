/**
 * Slack event router
 *
 * Routes Slack events from Bolt to matching workspace signals.
 * Handles event deduplication, channel filtering, and bot filtering.
 */

import type { Logger } from "@atlas/logger";
import type { WorkspaceSignalTriggerCallback } from "@atlas/workspace/types";
import type { WebClient } from "@slack/web-api";
import type { DaemonSignalTrigger } from "./conversation-handler.ts";
import { SlackConversationHandler } from "./conversation-handler.ts";
import type { SlackSignalMetadata, SlackSignalRegistrar } from "./registrar.ts";
import type { SlackChannelFilter, SlackChannelType, SlackSignalPayload } from "./schemas.ts";
import { SlackSignalPayloadSchema } from "./schemas.ts";

export interface SlackEventRouterOptions {
  logger: Logger;
  registrar: SlackSignalRegistrar;
  onSignalTrigger: WorkspaceSignalTriggerCallback<SlackSignalPayload>;
  boltClient: WebClient;
  daemon?: DaemonSignalTrigger;
}

export interface EventContext {
  teamId: string;
  eventId: string;
}

/**
 * Deduplication window for Slack Socket Mode events (5 minutes).
 * Slack guarantees at-least-once delivery. On reconnection, Slack may resend
 * events that weren't acknowledged. This window prevents double-processing
 * while allowing legitimate rapid-fire messages.
 */
const DEDUPLICATION_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Cleanup runs when both conditions met: interval elapsed AND size threshold reached.
 * Prevents unnecessary iteration on low-traffic workspaces while keeping memory bounded
 * on high-traffic ones.
 */
const DEDUPLICATION_CLEANUP_INTERVAL_MS = 60 * 1000; // 1 minute
const DEDUPLICATION_CLEANUP_THRESHOLD = 500; // events

/**
 * Event deduplicator with efficient sliding window cleanup
 */
class EventDeduplicator {
  private readonly seen = new Map<string, number>();
  private lastCleanup = Date.now();

  isDuplicate(eventId: string, ttlMs = DEDUPLICATION_TTL_MS): boolean {
    const now = Date.now();

    if (
      now - this.lastCleanup > DEDUPLICATION_CLEANUP_INTERVAL_MS &&
      this.seen.size > DEDUPLICATION_CLEANUP_THRESHOLD
    ) {
      const cutoff = now - ttlMs;
      for (const [id, ts] of this.seen.entries()) {
        if (ts < cutoff) {
          this.seen.delete(id);
        }
      }
      this.lastCleanup = now;
    }

    const lastSeen = this.seen.get(eventId);
    if (lastSeen && now - lastSeen < ttlMs) {
      return true;
    }

    this.seen.set(eventId, now);
    return false;
  }

  clear(): void {
    this.seen.clear();
  }
}

/**
 * Routes incoming Slack events to workspace signals
 */
export class SlackEventRouter {
  private readonly logger: Logger;
  private readonly registrar: SlackSignalRegistrar;
  private readonly onSignalTrigger: WorkspaceSignalTriggerCallback<SlackSignalPayload>;
  private readonly boltClient: WebClient;
  private readonly daemon: DaemonSignalTrigger | null;
  private readonly deduplicator = new EventDeduplicator();
  private conversationHandler: SlackConversationHandler | null = null;

  constructor(options: SlackEventRouterOptions) {
    this.logger = options.logger;
    this.registrar = options.registrar;
    this.onSignalTrigger = options.onSignalTrigger;
    this.boltClient = options.boltClient;
    this.daemon = options.daemon || null;
  }

  /**
   * Lazy-initialize conversation handler only when needed
   */
  private getConversationHandler(): SlackConversationHandler | null {
    if (!this.daemon) {
      return null;
    }

    if (!this.conversationHandler) {
      this.conversationHandler = new SlackConversationHandler(this.boltClient, this.daemon);
    }

    return this.conversationHandler;
  }

  /**
   * Route an event to matching workspace signals
   * Trust Bolt to deliver valid, typed events
   */
  async routeEvent(event: unknown, context: EventContext): Promise<void> {
    if (context.eventId && this.deduplicator.isDuplicate(context.eventId)) {
      this.logger.debug("Skipping duplicate event", { eventId: context.eventId });
      return;
    }

    // Trust Bolt's parsing - just check type field
    if (typeof event !== "object" || event === null || !("type" in event)) {
      return;
    }

    const typedEvent = event as Record<string, unknown>;

    // We only handle message (with channel_type) and app_mention events
    const isMessage = typedEvent.type === "message" && "channel_type" in typedEvent;
    const isAppMention = typedEvent.type === "app_mention";

    if (isMessage || isAppMention) {
      // Skip events without text (message_changed, message_deleted, etc.)
      // These subtypes have different structures - text may be nested or absent
      if (typeof typedEvent.text === "string") {
        await this.handleEvent(typedEvent, context, isMessage ? "message" : "app_mention");
      } else {
        this.logger.debug("Skipping event without text", {
          type: typedEvent.type,
          subtype: typedEvent.subtype,
          eventId: context.eventId,
        });
      }
    }
  }

  /**
   * Handle Slack event (message or app_mention)
   * Consolidated handler for all event types to reduce duplication
   */
  private async handleEvent(
    event: Record<string, unknown>,
    context: EventContext,
    eventType: "message" | "app_mention",
  ): Promise<void> {
    // Extract channel type and bot status based on event type
    const channelType =
      eventType === "message"
        ? (event.channel_type as SlackChannelType)
        : ("channel" as SlackChannelType);

    const channelFilter: SlackChannelFilter = channelType === "im" ? "dm" : channelType;
    const isBot = eventType === "message" ? !!event.bot_id : false;

    // Find matching signals for this event
    const matches = this.registrar.findMatchingSignals(eventType, channelFilter, isBot);

    if (matches.length === 0) {
      return;
    }

    // Transform to payload and trigger signals
    const payload = this.transformToPayload(event, context, channelType, isBot);
    await this.triggerMatchingSignals(matches, payload);
  }

  /**
   * Transform Slack event to signal payload
   * Only validate at OUR boundary (Slack → Atlas workspaces)
   */
  private transformToPayload(
    event: Record<string, unknown>,
    context: EventContext,
    channelType: SlackChannelType,
    isBot: boolean,
  ): SlackSignalPayload {
    const rawPayload = {
      messageId: event.ts,
      channelId: event.channel,
      channelType,
      userId: event.user,
      text: event.text,
      timestamp: event.ts,
      threadTs: event.thread_ts,
      teamId: context.teamId,
      isBot,
      botId: event.bot_id,
    };

    // Validate only at boundary (throws if Slack gave us something unexpected)
    return SlackSignalPayloadSchema.parse(rawPayload);
  }

  /**
   * Trigger all matching signals with payload
   */
  private async triggerMatchingSignals(
    matches: SlackSignalMetadata[],
    payload: SlackSignalPayload,
  ): Promise<void> {
    const triggers = matches.map(async (match) => {
      try {
        const handler = this.getConversationHandler();
        if (handler && match.workspaceId === handler.conversationWorkspaceId) {
          await handler.handleMessage(payload);
        } else {
          await this.onSignalTrigger(match.workspaceId, match.signalId, payload);
        }

        this.logger.info("Signal triggered", {
          workspaceId: match.workspaceId,
          signalId: match.signalId,
        });
      } catch (error) {
        this.logger.error("Failed to trigger signal", {
          error,
          workspaceId: match.workspaceId,
          signalId: match.signalId,
        });
        throw error;
      }
    });

    await Promise.all(triggers);
  }
}
