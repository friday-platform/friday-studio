/**
 * Platform signal endpoints — receive raw events from external messaging
 * platforms and delegate to the workspace's Chat SDK adapter (which handles
 * signature verification, parsing, and dispatch).
 */

import process from "node:process";
import { createLogger } from "@atlas/logger";
import type { Chat } from "chat";
import { Hono } from "hono";
import { z } from "zod";
import type { AtlasDaemon } from "../../src/atlas-daemon.ts";

const logger = createLogger({ component: "platform-signal-route" });

const SlackAppIdSchema = z.object({ api_app_id: z.string() });

/** Minimal shape of a WhatsApp webhook POST payload used for workspace routing. */
const WhatsAppWebhookPayloadSchema = z.object({
  entry: z
    .array(
      z.object({
        changes: z
          .array(
            z.object({
              value: z
                .object({ metadata: z.object({ phone_number_id: z.string() }).optional() })
                .optional(),
            }),
          )
          .optional(),
      }),
    )
    .optional(),
});

export function createPlatformSignalRoutes(daemon: AtlasDaemon) {
  const app = new Hono();

  // ─── Slack ─────────────────────────────────────────────────────────
  app.post("/slack", async (c) => {
    // Clone before consuming — SlackAdapter needs the raw body for sig verification
    const slackRequest = c.req.raw.clone();
    const rawBody = await c.req.text();

    let appId: string;
    try {
      appId = SlackAppIdSchema.parse(JSON.parse(rawBody)).api_app_id;
    } catch {
      logger.warn("slack_signal_missing_app_id", { bodyPreview: rawBody.slice(0, 200) });
      return c.json({ error: "Missing api_app_id in payload" }, 400);
    }

    logger.info("slack_signal_received", { appId });

    const workspaceId = await findWorkspaceByProvider(daemon, "slack", "app_id", appId);
    if (!workspaceId) {
      logger.warn("slack_no_workspace_for_app_id", { appId });
      return c.json({ error: "No workspace configured for this app_id" }, 404);
    }

    let chat: Chat;
    try {
      chat = (await daemon.getOrCreateChatSdkInstance(workspaceId)).chat;
    } catch (error) {
      logger.error("slack_chat_sdk_instance_failed", { error, workspaceId, appId });
      return c.json({ error: "Failed to initialize Chat SDK" }, 500);
    }

    if (!chat.webhooks.slack) {
      logger.warn("slack_no_adapter_for_workspace", { workspaceId, appId });
      return c.json({ error: "No Slack adapter configured for this workspace" }, 404);
    }

    try {
      return await chat.webhooks.slack(slackRequest);
    } catch (error) {
      logger.error("slack_webhook_handler_failed", { error, workspaceId, appId });
      return new Response("Internal error", { status: 500 });
    }
  });

  // ─── Telegram ──────────────────────────────────────────────────────
  // Internal atlasd route: /signals/telegram/<token_suffix>
  // External tunnel URL (what you set in Telegram's setWebhook):
  //   https://<tunnel>/platform/telegram/<token_suffix>
  //   → webhook-tunnel rewrites /platform/<provider>/... → /signals/<provider>/...
  // The token suffix is the segment after the colon in the bot token; it lets
  // us route to the right workspace without parsing the body first.
  app.post("/telegram/:tokenSuffix?", async (c) => {
    const telegramRequest = c.req.raw.clone();
    const tokenSuffix = c.req.param("tokenSuffix");

    // Find workspace: match by bot-token suffix first (multi-bot setups),
    // fall back to any telegram-provider workspace (single-bot env-var setups).
    // Suffix is computed on the fly from each workspace's resolved bot_token
    // rather than a stashed config field, so it survives config reloads and
    // doesn't rely on credential-resolution side-effects.
    const workspaceId =
      (tokenSuffix ? await findTelegramWorkspaceBySuffix(daemon, tokenSuffix) : null) ??
      (await findWorkspaceByProvider(daemon, "telegram"));
    if (!workspaceId) {
      logger.warn("telegram_no_workspace", { tokenSuffix });
      return c.json({ error: "No workspace configured for Telegram" }, 404);
    }

    logger.info("telegram_signal_received", { workspaceId, tokenSuffix });

    let chat: Chat;
    try {
      chat = (await daemon.getOrCreateChatSdkInstance(workspaceId)).chat;
    } catch (error) {
      logger.error("telegram_chat_sdk_instance_failed", { error, workspaceId });
      return c.json({ error: "Failed to initialize Chat SDK" }, 500);
    }

    if (!chat.webhooks.telegram) {
      logger.warn("telegram_no_adapter_for_workspace", { workspaceId });
      return c.json({ error: "No Telegram adapter configured for this workspace" }, 404);
    }

    try {
      return await chat.webhooks.telegram(telegramRequest);
    } catch (error) {
      logger.error("telegram_webhook_handler_failed", { error, workspaceId });
      return new Response("Internal error", { status: 500 });
    }
  });

  // ─── WhatsApp ─────────────────────────────────────────────────────
  // Meta sends two kinds of requests to this URL:
  //   GET  — verification handshake with ?hub.mode=subscribe&hub.verify_token=…&hub.challenge=…
  //   POST — event delivery, JSON body with entry[].changes[].value.metadata.phone_number_id
  //
  // Single WhatsApp webhook URL is configured in the Meta dashboard per app.
  // We route to the right workspace by matching:
  //   • GET: hub.verify_token against each whatsapp workspace's verify_token
  //   • POST: metadata.phone_number_id against each workspace's phone_number_id
  app.on(["GET", "POST"], "/whatsapp", async (c) => {
    if (c.req.method === "GET") {
      const url = new URL(c.req.raw.url);
      const verifyToken = url.searchParams.get("hub.verify_token");
      if (!verifyToken) {
        return c.text("Missing hub.verify_token", 400);
      }
      // Try explicit verify_token match first (multi-workspace setups pin
      // per-workspace tokens in signal.config.verify_token). Fall back to
      // "first whatsapp workspace" when config is empty — in that case the
      // adapter reads WHATSAPP_VERIFY_TOKEN from env and validates the token
      // itself inside handleVerificationChallenge, so routing by provider
      // alone is safe.
      const explicit = await findWorkspaceByProvider(
        daemon,
        "whatsapp",
        "verify_token",
        verifyToken,
      );
      let workspaceId: string | null = explicit;
      if (!workspaceId) {
        const all = await listWorkspacesByProvider(daemon, "whatsapp");
        if (all.length > 1) {
          // With multiple whatsapp workspaces and no explicit verify_token
          // pinning, the first-match routing is non-deterministic. Log loudly
          // so the operator knows to add per-workspace verify_token fields.
          logger.warn("whatsapp_verify_ambiguous_fallback", { candidates: all, picked: all[0] });
        }
        workspaceId = all[0] ?? null;
      }
      if (!workspaceId) {
        logger.warn("whatsapp_verify_no_workspace");
        return c.text("Forbidden", 403);
      }
      let chat: Chat;
      try {
        chat = (await daemon.getOrCreateChatSdkInstance(workspaceId)).chat;
      } catch (error) {
        logger.error("whatsapp_chat_sdk_instance_failed", { error, workspaceId });
        return c.json({ error: "Failed to initialize Chat SDK" }, 500);
      }
      if (!chat.webhooks.whatsapp) {
        logger.warn("whatsapp_no_adapter_for_workspace", { workspaceId });
        return c.text("Forbidden", 403);
      }
      try {
        return await chat.webhooks.whatsapp(c.req.raw);
      } catch (error) {
        logger.error("whatsapp_verify_failed", { error, workspaceId });
        return new Response("Internal error", { status: 500 });
      }
    }

    // POST — incoming events.
    const whatsappRequest = c.req.raw.clone();
    const rawBody = await c.req.text();
    let phoneNumberId: string | null = null;
    try {
      const parsed = WhatsAppWebhookPayloadSchema.parse(JSON.parse(rawBody));
      phoneNumberId = parsed.entry?.[0]?.changes?.[0]?.value?.metadata?.phone_number_id ?? null;
    } catch {
      logger.warn("whatsapp_webhook_invalid_payload", { bodyPreview: rawBody.slice(0, 200) });
      return c.json({ error: "Invalid payload" }, 400);
    }

    const workspaceId =
      (phoneNumberId
        ? await findWorkspaceByProvider(daemon, "whatsapp", "phone_number_id", phoneNumberId)
        : null) ?? (await findWorkspaceByProvider(daemon, "whatsapp"));

    if (!workspaceId) {
      logger.warn("whatsapp_no_workspace", { phoneNumberId });
      return c.json({ error: "No workspace configured for WhatsApp" }, 404);
    }

    logger.info("whatsapp_signal_received", { workspaceId, phoneNumberId });

    let chat: Chat;
    try {
      chat = (await daemon.getOrCreateChatSdkInstance(workspaceId)).chat;
    } catch (error) {
      logger.error("whatsapp_chat_sdk_instance_failed", { error, workspaceId });
      return c.json({ error: "Failed to initialize Chat SDK" }, 500);
    }

    if (!chat.webhooks.whatsapp) {
      logger.warn("whatsapp_no_adapter_for_workspace", { workspaceId, phoneNumberId });
      return c.json({ error: "No WhatsApp adapter configured for this workspace" }, 404);
    }

    try {
      return await chat.webhooks.whatsapp(whatsappRequest);
    } catch (error) {
      logger.error("whatsapp_webhook_handler_failed", { error, workspaceId });
      return new Response("Internal error", { status: 500 });
    }
  });

  return app;
}

/**
 * Find a workspace whose signal config matches a provider and optional
 * config key/value. Without a configKey, returns the first workspace
 * with a matching provider.
 */
async function findWorkspaceByProvider(
  daemon: AtlasDaemon,
  provider: string,
  configKey?: string,
  configValue?: string,
): Promise<string | null> {
  const workspaces = await daemon.getWorkspaceManager().list();

  for (const ws of workspaces) {
    const config = await daemon.getWorkspaceManager().getWorkspaceConfig(ws.id);
    if (!config) continue;

    const signals = config.workspace.signals;
    if (!signals) continue;

    for (const signal of Object.values(signals)) {
      if (signal.provider !== provider) continue;
      if (!configKey) return ws.id;
      const cfg = signal && "config" in signal ? signal.config : undefined;
      if (
        cfg &&
        typeof cfg === "object" &&
        configKey in cfg &&
        (cfg as Record<string, unknown>)[configKey] === configValue
      ) {
        return ws.id;
      }
    }
  }

  return null;
}

/**
 * Return every workspace id that has at least one signal with the given
 * provider. Used for fallback/ambiguity detection in webhook routing.
 */
async function listWorkspacesByProvider(daemon: AtlasDaemon, provider: string): Promise<string[]> {
  const workspaces = await daemon.getWorkspaceManager().list();
  const matches: string[] = [];

  for (const ws of workspaces) {
    const config = await daemon.getWorkspaceManager().getWorkspaceConfig(ws.id);
    const signals = config?.workspace.signals;
    if (!signals) continue;
    if (Object.values(signals).some((s) => s?.provider === provider)) {
      matches.push(ws.id);
    }
  }

  return matches;
}

/**
 * Find the workspace whose Telegram bot_token's post-colon suffix matches
 * `tokenSuffix`. Resolves the bot_token from signal.config or the workspace's
 * `TELEGRAM_BOT_TOKEN` env fallback, computing the suffix on the fly so it
 * doesn't depend on credential-resolution side-effects.
 */
async function findTelegramWorkspaceBySuffix(
  daemon: AtlasDaemon,
  tokenSuffix: string,
): Promise<string | null> {
  const workspaces = await daemon.getWorkspaceManager().list();

  for (const ws of workspaces) {
    const config = await daemon.getWorkspaceManager().getWorkspaceConfig(ws.id);
    const signals = config?.workspace.signals;
    if (!signals) continue;

    for (const signal of Object.values(signals)) {
      if (signal?.provider !== "telegram") continue;
      const cfg = "config" in signal ? signal.config : undefined;
      const cfgToken =
        cfg && typeof cfg === "object" && "bot_token" in cfg
          ? (cfg as Record<string, unknown>).bot_token
          : undefined;
      const botToken =
        (typeof cfgToken === "string" ? cfgToken : null) ?? process.env.TELEGRAM_BOT_TOKEN;
      if (typeof botToken !== "string" || !botToken.includes(":")) continue;
      if (botToken.split(":")[1] === tokenSuffix) return ws.id;
    }
  }

  return null;
}
