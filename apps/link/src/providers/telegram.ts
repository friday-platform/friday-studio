import { randomBytes } from "node:crypto";
import { logger } from "@atlas/logger";
import { z } from "zod";
import { defineApiKeyProvider } from "./types.ts";

/**
 * Telegram bot apikey provider.
 *
 * The user pastes only their `bot_token`. The `webhook_secret` is generated
 * server-side at credential creation time and stored alongside the bot token.
 * Daemon-side webhook setup uses the stored secret when calling Telegram's
 * `setWebhook(secret_token=...)` so Telegram echoes it back in the
 * `x-telegram-bot-api-secret-token` header for webhook authenticity checks.
 *
 * Field names mirror `TelegramProviderConfigSchema` in
 * `packages/config/src/signals.ts`.
 */
const TelegramSecretSchema = z.object({ bot_token: z.string().min(1) });

/**
 * Stored secret post-`autoFields` injection. `webhook_secret` is required for
 * the `registerWebhook` hook (Telegram's `setWebhook` accepts it as
 * `secret_token`).
 */
const TelegramStoredSecretSchema = z.object({
  bot_token: z.string().min(1),
  webhook_secret: z.string().min(1),
});

/** Subset of Telegram Bot API response we consume. */
const TelegramApiResponseSchema = z.object({
  ok: z.boolean(),
  description: z.string().optional(),
  result: z.unknown().optional(),
});

export const telegramProvider = defineApiKeyProvider({
  id: "telegram",
  displayName: "Telegram",
  description: "Connect a Telegram bot to receive messages and post replies",
  docsUrl: "https://core.telegram.org/bots#how-do-i-create-a-bot",
  secretSchema: TelegramSecretSchema,
  autoFields: () => ({ webhook_secret: randomBytes(32).toString("hex") }),
  setupInstructions: `
1. Open [@BotFather](https://t.me/BotFather) in Telegram
2. Send \`/newbot\` and follow the prompts to name your bot
3. Copy the bot token BotFather sends back (\`123456:ABC-DEF...\`) and paste it below
`,
  registerWebhook: async ({ secret, callbackBaseUrl, connectionId }) => {
    const parsed = TelegramStoredSecretSchema.parse(secret);
    const url = `${callbackBaseUrl}/platform/telegram/${connectionId}`;
    const res = await fetch(`https://api.telegram.org/bot${parsed.bot_token}/setWebhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, secret_token: parsed.webhook_secret }),
    });
    const body: unknown = await res.json().catch(() => ({}));
    const parsedBody = TelegramApiResponseSchema.safeParse(body);
    if (!res.ok || !parsedBody.success || !parsedBody.data.ok) {
      const desc = parsedBody.success ? parsedBody.data.description : `HTTP ${res.status}`;
      throw new Error(`Telegram setWebhook failed: ${desc ?? "unknown"}`);
    }
    logger.info("telegram_webhook_registered", { url, connectionId });
  },
  unregisterWebhook: async ({ secret }) => {
    const parsed = TelegramSecretSchema.parse(secret);
    // Best-effort: caller (`/disconnect`) catches and continues.
    await fetch(`https://api.telegram.org/bot${parsed.bot_token}/deleteWebhook`, {
      method: "POST",
    });
    logger.info("telegram_webhook_unregistered", {});
  },
});
