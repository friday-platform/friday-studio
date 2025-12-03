/**
 * Self-contained Discord bot integration for Atlas daemon.
 */

import process from "node:process";
import type { AtlasUIMessageChunk } from "@atlas/agent-sdk";
import { logger } from "@atlas/logger";
import type { WorkspaceManager } from "@atlas/workspace";
import type { WorkspaceSignalTriggerCallback } from "@atlas/workspace/types";
import { Hono } from "hono";
import { registerCommands as registerDiscordCommands } from "./command-registrar.ts";
import { DiscordConversationHandler } from "./conversation.ts";
import { DiscordEventRouter } from "./event-router.ts";
import { DiscordGateway } from "./gateway.ts";
import { DiscordInteractionHandler } from "./interaction-handler.ts";
import type { DiscordSignalRegistrar } from "./registrar.ts";
import { DiscordBotConfigSchema } from "./schemas.ts";

/**
 * Interface for daemon's signal triggering capability
 * Matches AtlasDaemon's triggerWorkspaceSignal method signature
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
 * Facade for Discord bot integration: configuration, components, and HTTP endpoints.
 */
export class DiscordIntegration {
  private interactionHandler: DiscordInteractionHandler | null = null;
  private gateway: DiscordGateway | null = null;
  private eventRouter: DiscordEventRouter | null = null;
  private httpHandler: Hono | null = null;
  private botToken: string | null = null;
  private applicationId: string | null = null;

  /**
   * Initialize Discord integration
   *
   * @param signalRegistrar - Tracks Discord signals across workspaces
   * @param workspaceManager - Manages workspace metadata and lifecycle
   * @param onWakeup - Callback for fire-and-forget signal triggers (Gateway events)
   * @param daemon - Daemon reference for signal triggering
   */
  async initialize(
    signalRegistrar: DiscordSignalRegistrar,
    workspaceManager: WorkspaceManager,
    onWakeup: WorkspaceSignalTriggerCallback,
    daemon: DaemonSignalTrigger,
  ): Promise<void> {
    if (this.httpHandler !== null) {
      logger.warn("Discord integration already initialized");
      return;
    }

    // Load configuration from environment
    const config = this.loadConfig();
    if (!config) {
      logger.info("Discord integration disabled (missing configuration)");
      return;
    }

    logger.info("Initializing Discord integration...", { applicationId: config.applicationId });

    // Store credentials for command registration
    this.botToken = config.botToken;
    this.applicationId = config.applicationId;

    try {
      this.interactionHandler = new DiscordInteractionHandler(
        signalRegistrar,
        workspaceManager,
        config.applicationId,
        config.publicKey,
        config.botToken,
        daemon,
      );

      const conversationHandler = new DiscordConversationHandler(config.botToken, daemon);

      this.eventRouter = new DiscordEventRouter(
        signalRegistrar,
        onWakeup,
        config.applicationId,
        conversationHandler,
      );

      this.gateway = new DiscordGateway(config.botToken, async (event) => {
        if (this.eventRouter) {
          try {
            await this.eventRouter.routeEvent(event);
          } catch (error) {
            logger.error("Failed to route Discord event", { error, eventType: event.type });
          }
        }
      });

      await this.gateway.connect();

      this.httpHandler = new Hono();
      this.httpHandler.post("/interactions", async (c) => {
        if (!this.interactionHandler) {
          logger.error("Discord interaction handler not initialized");
          return c.json({ error: "Discord integration not configured" }, 503);
        }

        try {
          return await this.interactionHandler.handleInteraction(c);
        } catch (error) {
          logger.error("Discord interaction handler error", { error });
          return c.json({ error: "Internal server error" }, 500);
        }
      });

      logger.info("Discord integration initialized", {
        applicationId: config.applicationId,
        gateway: "connected",
      });
    } catch (error) {
      logger.error("Failed to initialize Discord integration", { error });
      throw error;
    }
  }

  /**
   * Register Discord commands after workspaces are loaded
   *
   * Registers /atlas commands (ping, workspaces, chat) with Discord.
   */
  async registerCommands(): Promise<void> {
    if (!this.botToken || !this.applicationId) {
      return;
    }

    try {
      await registerDiscordCommands(this.botToken, this.applicationId);
    } catch (error) {
      logger.error("Failed to register Discord commands", { error });
      // Don't throw - continue daemon startup even if command registration fails
    }
  }

  /**
   * Get HTTP handler for Discord webhook endpoint
   *
   * @returns Hono app to mount at /discord/interactions, or null if not initialized
   */
  getHttpHandler(): Hono | null {
    return this.httpHandler;
  }

  /**
   * Shutdown Discord integration
   *
   * Cleans up resources. Commands remain registered with Discord.
   */
  async shutdown(): Promise<void> {
    if (this.httpHandler === null) {
      return;
    }

    logger.info("Shutting down Discord integration...");

    // Disconnect Gateway
    if (this.gateway) {
      await this.gateway.disconnect();
      this.gateway = null;
    }

    this.interactionHandler = null;
    this.httpHandler = null;
    this.botToken = null;
    this.applicationId = null;

    logger.info("Discord integration shutdown complete");
  }

  /**
   * Load Discord configuration from environment variables
   *
   * @returns Validated Discord config or null if not configured
   */
  private loadConfig() {
    const botToken = process.env.ATLAS_DISCORD_BOT_TOKEN;
    const applicationId = process.env.ATLAS_DISCORD_APPLICATION_ID;
    const publicKey = process.env.ATLAS_DISCORD_PUBLIC_KEY;

    // If none are set, Discord is not configured
    if (!botToken && !applicationId && !publicKey) {
      return null;
    }

    // If some are set but not all, that's a configuration error
    try {
      return DiscordBotConfigSchema.parse({ botToken, applicationId, publicKey });
    } catch (error) {
      logger.error("Invalid Discord configuration", {
        error,
        hint: "Set all three: ATLAS_DISCORD_BOT_TOKEN, ATLAS_DISCORD_APPLICATION_ID, ATLAS_DISCORD_PUBLIC_KEY",
      });
      return null;
    }
  }
}
