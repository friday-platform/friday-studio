/**
 * WebSocket connection to Discord Gateway for receiving message events.
 */

import { logger } from "@atlas/logger";
import {
  Client,
  GatewayDispatchEvents,
  GatewayIntentBits,
  type GatewayMessageCreateDispatchData,
  type GatewayMessageUpdateDispatchData,
} from "@discordjs/core";
import { WebSocketManager } from "@discordjs/ws";
import { createAuthenticatedRestClient } from "./utils.ts";

/**
 * Gateway events from Discord WebSocket
 * Uses library's typed event data directly
 */
export type GatewayEvent =
  | { type: typeof GatewayDispatchEvents.MessageCreate; data: GatewayMessageCreateDispatchData }
  | { type: typeof GatewayDispatchEvents.MessageUpdate; data: GatewayMessageUpdateDispatchData };

/**
 * Gateway event handler callback
 */
export type GatewayEventHandler = (event: GatewayEvent) => Promise<void> | void;

/**
 * WebSocket client for Discord Gateway. Listens for MESSAGE_CREATE and MESSAGE_UPDATE events.
 */
export class DiscordGateway {
  private manager: WebSocketManager;
  private client: Client;
  private isConnected = false;

  /**
   * Create Discord Gateway client
   *
   * @param botToken - Discord bot token for authentication
   * @param eventHandler - Callback to receive Gateway events
   */
  constructor(
    botToken: string,
    private readonly eventHandler: GatewayEventHandler,
  ) {
    const rest = createAuthenticatedRestClient(botToken);

    this.manager = new WebSocketManager({
      token: botToken,
      intents:
        GatewayIntentBits.GuildMessages |
        GatewayIntentBits.DirectMessages |
        GatewayIntentBits.MessageContent |
        GatewayIntentBits.Guilds,
      rest,
    });

    this.client = new Client({ rest, gateway: this.manager });
  }

  /**
   * Connect to Discord Gateway
   *
   * Establishes WebSocket connection and starts listening for events.
   * Automatically handles reconnection on disconnect.
   */
  async connect(): Promise<void> {
    if (this.isConnected) {
      logger.warn("Discord Gateway already connected");
      return;
    }

    try {
      logger.info("Connecting to Discord Gateway...");

      // Register event handlers
      // @discordjs/core provides typed data from discord-api-types
      this.client.on(GatewayDispatchEvents.MessageCreate, async ({ data }) => {
        await this.onMessageCreate(data);
      });

      this.client.on(GatewayDispatchEvents.MessageUpdate, async ({ data }) => {
        await this.onMessageUpdate(data);
      });

      // Connect to Gateway
      await this.manager.connect();

      this.isConnected = true;
      logger.info("Discord Gateway connected successfully");
    } catch (error) {
      logger.error("Failed to connect to Discord Gateway", { error });
      throw error;
    }
  }

  /**
   * Disconnect from Discord Gateway
   *
   * Closes WebSocket connection and cleans up resources.
   */
  async disconnect(): Promise<void> {
    if (!this.isConnected) {
      return;
    }

    try {
      logger.info("Disconnecting from Discord Gateway...");
      await this.manager.destroy();
      this.isConnected = false;
      logger.info("Discord Gateway disconnected");
    } catch (error) {
      logger.error("Error disconnecting from Discord Gateway", { error });
      throw error;
    }
  }

  /**
   * Handle MESSAGE_CREATE event from Gateway
   */
  private async onMessageCreate(data: GatewayMessageCreateDispatchData): Promise<void> {
    try {
      await this.eventHandler({ type: GatewayDispatchEvents.MessageCreate, data });
    } catch (error) {
      logger.error("Error handling MESSAGE_CREATE event", { error, messageId: data.id });
    }
  }

  /**
   * Handle MESSAGE_UPDATE event from Gateway
   */
  private async onMessageUpdate(data: GatewayMessageUpdateDispatchData): Promise<void> {
    try {
      await this.eventHandler({ type: GatewayDispatchEvents.MessageUpdate, data });
    } catch (error) {
      logger.error("Error handling MESSAGE_UPDATE event", { error, messageId: data.id });
    }
  }
}
