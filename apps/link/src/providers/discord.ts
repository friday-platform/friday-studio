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
 * `registerWebhook` PATCHes the application's Interactions Endpoint URL via
 * `PATCH /api/v10/applications/{application_id}`. Discord verifies the
 * endpoint with a PING immediately after the PATCH, so the daemon's webhook
 * tunnel must be reachable when this fires (matches the tunnel-up precondition
 * Telegram already enforces in atlasd's connect-communicator route).
 *
 * Field names mirror `DiscordProviderConfigSchema` in
 * `packages/config/src/signals.ts`.
 */
export const DiscordSecretSchema = z.object({
  bot_token: z.string().min(1),
  public_key: z.string().min(1),
  application_id: z.string().min(1),
});

/**
 * Subset of Discord's edit-application response we consume. Discord echoes
 * back the full Application object on 200 — we only assert the request was
 * accepted and look at `message` for non-2xx error bodies.
 */
const DiscordApiErrorSchema = z.object({ message: z.string().optional() });

export const discordProvider = defineApiKeyProvider({
  id: "discord",
  displayName: "Discord",
  description: "Connect a Discord bot to receive interactions and post replies",
  docsUrl: "https://discord.com/developers/docs/resources/application#edit-current-application",
  secretSchema: DiscordSecretSchema,
  setupInstructions: `
1. Open the [Discord Developer Portal](https://discord.com/developers/applications) and create a new application
2. Under **Bot**, reset and copy the bot token
3. Under **General Information**, copy the application ID and the public key
4. Paste all three values below — Friday will set the Interactions Endpoint URL for you
`,
  registerWebhook: async ({ secret, callbackBaseUrl, connectionId }) => {
    const parsed = DiscordSecretSchema.parse(secret);
    const url = `${callbackBaseUrl}/platform/discord/${connectionId}`;
    const res = await fetch(`https://discord.com/api/v10/applications/${parsed.application_id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bot ${parsed.bot_token}` },
      body: JSON.stringify({ interactions_endpoint_url: url }),
    });
    if (!res.ok) {
      const body: unknown = await res.json().catch(() => ({}));
      const err = DiscordApiErrorSchema.safeParse(body);
      const desc = err.success && err.data.message ? err.data.message : `HTTP ${res.status}`;
      throw new Error(`Discord set interactions endpoint failed: ${desc}`);
    }
    logger.info("discord_webhook_registered", { url, connectionId });
  },
  unregisterWebhook: async ({ secret }) => {
    const parsed = DiscordSecretSchema.parse(secret);
    // Best-effort: caller (`/disconnect`) catches and continues.
    await fetch(`https://discord.com/api/v10/applications/${parsed.application_id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bot ${parsed.bot_token}` },
      body: JSON.stringify({ interactions_endpoint_url: null }),
    });
    logger.info("discord_webhook_unregistered", {});
  },
});
