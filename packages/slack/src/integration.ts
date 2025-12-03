/**
 * Slack integration using Bolt framework for Socket Mode
 *
 * Uses @slack/bolt for WebSocket connection management, automatic event acknowledgment,
 * and type-safe event handling. Delegates event routing to SlackEventRouter to support
 * Atlas's dynamic workspace signal registration pattern.
 */

import process from "node:process";
import { logger } from "@atlas/logger";
import type { WorkspaceSignalTriggerCallback } from "@atlas/workspace/types";
import { App, LogLevel } from "@slack/bolt";
import type { DaemonSignalTrigger } from "./conversation-handler.ts";
import { SlackEventRouter } from "./event-router.ts";
import type { SlackSignalRegistrar } from "./registrar.ts";
import type { SlackSignalPayload } from "./schemas.ts";

/**
 * Slack configuration loaded from environment
 */
interface SlackBotConfig {
  appToken: string; // App-level token (xapp-...) for Socket Mode
  botToken: string; // Bot token (xoxb-...) for API calls
}

/**
 * Slack integration facade using Bolt framework
 *
 * Architecture:
 * - Bolt App: Handles Socket Mode connection, auto-ack, event parsing
 * - Single catch-all listeners: Route all events to SlackEventRouter
 * - SlackEventRouter: Matches events to workspace signals (dynamic registration)
 * - SlackConversationHandler: Special handling for atlas-conversation workspace
 *
 * Why catch-all listeners?
 * Bolt doesn't support removing listeners dynamically (GitHub #1217).
 * Atlas loads workspaces at runtime with dynamic signal registration,
 * so we use a single listener that delegates to our flexible router.
 */
export class SlackIntegration {
  private app: App | null = null;
  private registrar: SlackSignalRegistrar | null = null;
  private router: SlackEventRouter | null = null;

  /**
   * Initialize Slack integration with Bolt framework
   *
   * @param signalRegistrar - Tracks Slack signals across workspaces
   * @param onWakeup - Callback for signal triggers (Socket Mode events)
   * @param daemon - Daemon reference for conversation streaming
   */
  async initialize(
    signalRegistrar: SlackSignalRegistrar,
    onWakeup: WorkspaceSignalTriggerCallback<SlackSignalPayload>,
    daemon: DaemonSignalTrigger,
  ): Promise<void> {
    // Load configuration from environment
    const config = this.loadConfig();
    if (!config) {
      logger.info("Slack integration disabled (missing configuration)");
      return;
    }

    logger.info("Initializing Slack Bolt integration...");

    try {
      this.registrar = signalRegistrar;

      // Initialize Bolt App with Socket Mode
      this.app = new App({
        token: config.botToken,
        appToken: config.appToken,
        socketMode: true,
        logLevel: LogLevel.INFO,
      });

      // Create event router (delegates to workspace signals)
      this.router = new SlackEventRouter({
        logger: logger.child({ component: "slack-router" }),
        registrar: this.registrar,
        onSignalTrigger: onWakeup,
        boltClient: this.app.client,
        daemon,
      });

      // Register catch-all event listeners
      this.registerBoltListeners();

      // Start Bolt app (connects to Socket Mode)
      await this.app.start();

      logger.info("Slack Bolt integration initialized");
    } catch (error) {
      logger.error("Failed to initialize Slack integration", { error });
      throw error;
    }
  }

  /**
   * Register Bolt event listeners
   *
   * Uses catch-all listeners that delegate to SlackEventRouter.
   * This pattern supports dynamic workspace signal registration
   * (Bolt doesn't allow removing listeners at runtime).
   */
  private registerBoltListeners(): void {
    if (!this.app || !this.router) {
      return;
    }

    // Capture router reference for safe closure access
    const router = this.router;

    // Catch-all message listener
    // Bolt automatically acknowledges Events API events (no manual ack() needed)
    this.app.message(async ({ message, body }) => {
      try {
        await router.routeEvent(message, {
          teamId: body.team_id || "",
          eventId: body.event_id || "",
        });
      } catch (error) {
        logger.error("Failed to route message event", { error, eventId: body.event_id });
      }
    });

    // Catch-all app_mention listener
    this.app.event("app_mention", async ({ event, body }) => {
      try {
        await router.routeEvent(event, {
          teamId: body.team_id || "",
          eventId: body.event_id || "",
        });
      } catch (error) {
        logger.error("Failed to route app_mention event", { error, eventId: body.event_id });
      }
    });

    // Global error handler
    // Note: Bolt's error handler signature requires async even if we don't await
    // deno-lint-ignore require-await
    this.app.error(async (error) => {
      logger.error("Slack Bolt error", { error });
    });
  }

  /**
   * Get the registrar for workspace signal registration (if initialized)
   */
  getRegistrar(): SlackSignalRegistrar | null {
    return this.registrar;
  }

  /**
   * Shutdown Slack integration
   *
   * Stops Bolt app and cleans up resources.
   */
  async shutdown(): Promise<void> {
    if (!this.app) {
      return;
    }

    logger.info("Shutting down Slack integration...");

    try {
      await this.app.stop();
    } catch (error) {
      logger.error("Error stopping Bolt app", { error });
    }

    this.app = null;

    if (this.registrar) {
      await this.registrar.shutdown();
    }

    this.router = null;
    this.registrar = null;

    logger.info("Slack integration shutdown complete");
  }

  /**
   * Load Slack configuration from environment variables
   *
   * Bolt will validate token formats and fail fast with clear errors if invalid.
   *
   * @returns Slack config or null if not configured
   */
  private loadConfig(): SlackBotConfig | null {
    const appToken = process.env.ATLAS_SLACK_APP_TOKEN;
    const botToken = process.env.ATLAS_SLACK_BOT_TOKEN;

    if (!appToken || !botToken) {
      return null;
    }

    return { appToken, botToken };
  }
}
