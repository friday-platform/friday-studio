import { logger } from "@atlas/logger";
import { z } from "zod";
import { defineApiKeyProvider } from "./types.ts";

/**
 * Discord bot apikey provider.
 *
 * The user pastes `bot_token`, `public_key`, and `application_id` from the
 * Discord Developer Portal — all three are issued by Discord, so there are no
 * server-generated `autoFields`.
 *
 * **No webhook registration:** Friday receives Discord events through the
 * Discord WebSocket **Gateway** (wired by `discord-gateway-service` in
 * `apps/atlasd/src/atlas-daemon.ts`), not via the per-application
 * `interactions_endpoint_url` webhook. The Gateway transport already handles
 * inbound messages with just the bot token, so there is nothing to register
 * upstream. `registerWebhook` is therefore a documented no-op that emits a
 * guidance log; `unregisterWebhook` is symmetric.
 *
 * If we later add slash-command-style interactions, the admin can set the
 * Interactions Endpoint URL manually in the Discord Developer Portal — Friday
 * does not configure it automatically.
 *
 * Field names mirror `DiscordProviderConfigSchema` in
 * `packages/config/src/signals.ts`.
 */
const DiscordSecretSchema = z.object({
  bot_token: z.string().min(1),
  public_key: z.string().min(1),
  application_id: z.string().min(1),
});

export const discordProvider = defineApiKeyProvider({
  id: "discord",
  displayName: "Discord",
  description: "Connect a Discord bot to receive interactions and post replies",
  docsUrl: "https://discord.com/developers/docs/topics/gateway",
  secretSchema: DiscordSecretSchema,
  setupInstructions: `
1. Open the [Discord Developer Portal](https://discord.com/developers/applications) and create a new application
2. Under **Bot**, reset and copy the bot token
3. Under **General Information**, copy the application ID and the public key
4. Paste all three values below

Friday connects to Discord via the **Gateway** (WebSocket) using the
credentials above — no webhook URL needs to be registered. If you later need
slash-command-style interactions, set the **Interactions Endpoint URL**
manually in the Discord Developer Portal.
`,
  // deno-lint-ignore require-await
  registerWebhook: async ({ connectionId }) => {
    // Discord events arrive via the WebSocket Gateway (see
    // `discord-gateway-service` in `apps/atlasd/src/atlas-daemon.ts`), so
    // there is nothing to register upstream. Surfaced as a logger event so
    // operators can grep for it during smoke tests.
    logger.info("discord_webhook_register_noop", {
      connectionId,
      reason:
        "Discord uses WebSocket Gateway for events, not webhook URLs. No registration needed.",
    });
  },
  // deno-lint-ignore require-await
  unregisterWebhook: async ({ connectionId }) => {
    logger.info("discord_webhook_unregister_noop", {
      connectionId,
      reason: "Gateway transport — nothing to unregister upstream.",
    });
  },
});
