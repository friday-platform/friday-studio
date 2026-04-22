/**
 * Daemon-scoped Discord Gateway supervisor. One instance per daemon owns the
 * WebSocket connection to Discord; every inbound event is forwarded as an HTTP
 * POST to `/signals/discord`, where the per-workspace adapter handles it on a
 * freshly-woken ChatSdkInstance — mirroring the Slack/Telegram/WhatsApp
 * webhook path.
 */

import { ChatSdkStateAdapter } from "@atlas/core/chat/chat-sdk-state-adapter";
import type { Logger } from "@atlas/logger";
import { createDiscordAdapter, DiscordAdapter } from "@chat-adapter/discord";
import { Chat } from "chat";
import { toDiscordLogger } from "./chat-sdk/discord-logger.ts";
import {
  cancellableSleep,
  DISCORD_GATEWAY_DURATION_MS,
  DISCORD_GATEWAY_RETRY_DELAY_MS,
  isDiscordAuthError,
} from "./chat-sdk/discord-supervisor-utils.ts";

export interface DiscordGatewayServiceDeps {
  credentials: { botToken: string; publicKey: string; applicationId: string };
  /** `http://localhost:<daemonPort>/signals/discord` — where Gateway events are forwarded. */
  forwardUrl: string;
  logger: Logger;
  /**
   * Injection seam for tests — pass a stub `DiscordAdapter`-shaped object to
   * avoid spinning a real WebSocket. Defaults to `createDiscordAdapter`.
   */
  adapterFactory?: (creds: DiscordGatewayServiceDeps["credentials"], logger: Logger) => DiscordAdapter;
}

export class DiscordGatewayService {
  private readonly deps: DiscordGatewayServiceDeps;
  private readonly controller = new AbortController();
  private adapter: DiscordAdapter | null = null;
  private loopPromise: Promise<void> | null = null;
  private currentListenerPromise: Promise<unknown> | undefined;

  constructor(deps: DiscordGatewayServiceDeps) {
    this.deps = deps;
  }

  async start(): Promise<void> {
    if (this.loopPromise) return;

    const { credentials, logger } = this.deps;
    const factory =
      this.deps.adapterFactory ??
      ((creds, log) =>
        createDiscordAdapter({
          botToken: creds.botToken,
          publicKey: creds.publicKey,
          applicationId: creds.applicationId,
          logger: toDiscordLogger(log),
        }));

    this.adapter = factory(credentials, logger);

    // The adapter's `startGatewayListener` short-circuits with HTTP 500 unless
    // `adapter.chat` is set. Spinning up a minimal Chat with ONLY the Discord
    // adapter (no handlers, no state adapter) is enough — we never dispatch
    // through this Chat; all routing happens after the forwarded HTTP hop.
    // `state` is required by the Chat config even though we never dispatch
     // messages through this Chat — every real route happens after the
     // forwarded HTTP hop reaches the per-workspace adapter. `ChatSdkStateAdapter`
     // is the least-effort choice: already in the tree, no new deps.
    const chat = new Chat({
      userName: "Friday",
      adapters: { discord: this.adapter },
      state: new ChatSdkStateAdapter({
        userId: "daemon-discord-gateway",
        workspaceId: "daemon-discord-gateway",
      }),
      concurrency: "concurrent",
      logger: "silent",
    });
    await chat.initialize();

    this.loopPromise = this.loop();
    this.loopPromise.catch((error) => {
      logger.error("discord_gateway_service_crashed", { error });
    });

    logger.info("discord_gateway_service_started", {
      forwardUrl: this.deps.forwardUrl,
      applicationId: credentials.applicationId,
    });
  }

  async stop(): Promise<void> {
    if (!this.loopPromise) return;
    this.controller.abort();
    await Promise.allSettled([this.currentListenerPromise, this.loopPromise]);
    this.loopPromise = null;
    // release adapter so the discord.js Client underneath is GC-eligible
    this.adapter = null;
    this.deps.logger.info("discord_gateway_service_stopped");
  }

  private async loop(): Promise<void> {
    const adapter = this.adapter;
    if (!adapter) return;

    while (!this.controller.signal.aborted) {
      let listenerPromise: Promise<unknown> | undefined;
      try {
        await adapter.startGatewayListener(
          {
            waitUntil: (task: Promise<unknown>) => {
              listenerPromise = task;
              this.currentListenerPromise = task;
            },
          },
          DISCORD_GATEWAY_DURATION_MS,
          this.controller.signal,
          this.deps.forwardUrl,
        );
        if (listenerPromise) {
          await listenerPromise;
        }
      } catch (error) {
        if (isDiscordAuthError(error)) {
          this.deps.logger.error("discord_gateway_auth_failed", { error });
          break;
        }
        this.deps.logger.warn("discord_gateway_listener_error", { error });
        await cancellableSleep(DISCORD_GATEWAY_RETRY_DELAY_MS, this.controller.signal);
      }
    }
  }
}
