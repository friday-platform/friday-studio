/**
 * Platform signal endpoints — receive raw events from external messaging
 * platforms and delegate to the workspace's Chat SDK adapter (which handles
 * signature verification, parsing, and dispatch).
 */

import process from "node:process";
import { createLogger } from "@atlas/logger";
import type { Chat } from "chat";
import type { Context } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import type { AtlasDaemon } from "../../src/atlas-daemon.ts";
import { resolveCommunicatorByConnection } from "../../src/services/communicator-wiring.ts";

const logger = createLogger({ component: "platform-signal-route" });

type PlatformProvider = "slack" | "discord" | "telegram" | "whatsapp" | "teams";

const PROVIDER_LABELS: Record<PlatformProvider, string> = {
  slack: "Slack",
  discord: "Discord",
  telegram: "Telegram",
  whatsapp: "WhatsApp",
  teams: "Teams",
};

/**
 * Resolve the workspace's Chat SDK instance, check it exposes a webhook for
 * `provider`, and forward the (already-cloned) raw request. Centralizes the
 * 500/404/500 error tail repeated across every platform route.
 */
async function delegateToWebhook(
  c: Context,
  daemon: AtlasDaemon,
  provider: PlatformProvider,
  workspaceId: string,
  request: Request,
  logContext: Record<string, unknown> = {},
): Promise<Response> {
  let chat: Chat;
  try {
    chat = (await daemon.getOrCreateChatSdkInstance(workspaceId)).chat;
  } catch (error) {
    logger.error(`${provider}_chat_sdk_instance_failed`, { error, workspaceId, ...logContext });
    return c.json({ error: "Failed to initialize Chat SDK" }, 500);
  }

  const webhook = chat.webhooks[provider];
  if (!webhook) {
    logger.warn(`${provider}_no_adapter_for_workspace`, { workspaceId, ...logContext });
    return c.json(
      { error: `No ${PROVIDER_LABELS[provider]} adapter configured for this workspace` },
      404,
    );
  }

  try {
    return await webhook(request);
  } catch (error) {
    logger.error(`${provider}_webhook_handler_failed`, { error, workspaceId, ...logContext });
    return new Response("Internal error", { status: 500 });
  }
}

const SlackAppIdSchema = z.object({ api_app_id: z.string() });

const SlackUrlVerificationSchema = z.object({
  type: z.literal("url_verification"),
  challenge: z.string(),
});

/** Minimal shape of a Teams activity payload used for workspace routing. */
const TeamsRoutingPayloadSchema = z.object({ recipient: z.object({ id: z.string() }) });

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

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      logger.warn("slack_signal_invalid_json", { bodyPreview: rawBody.slice(0, 200) });
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    // Slack sends this during Event Subscriptions URL registration. It has no
    // api_app_id and no signature we can verify against a workspace — Slack
    // just wants the `challenge` value echoed. Mirrors signal-gateway's
    // handlePerAppSlackWebhook; keeps atlasd self-sufficient for dev setups
    // that don't run the Go gateway.
    const urlVerify = SlackUrlVerificationSchema.safeParse(parsed);
    if (urlVerify.success) {
      logger.info("slack_url_verification_challenge");
      return new Response(urlVerify.data.challenge, {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      });
    }

    let appId: string;
    try {
      appId = SlackAppIdSchema.parse(parsed).api_app_id;
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

    return delegateToWebhook(c, daemon, "slack", workspaceId, slackRequest, { appId });
  });

  // ─── Discord ───────────────────────────────────────────────────────
  // Internal atlasd route: /signals/discord. The daemon runs ONE Gateway
  // connection (`DiscordGatewayService`) that HTTP-POSTs every event to
  // `http://localhost:<port>/signals/discord` with the
  // `x-discord-gateway-token` header — no webhook-tunnel involved; the
  // daemon talks to itself.
  // Forward-compat: raw Interactions POSTs (PING, commands) are also accepted
  // — the per-workspace adapter's `handleWebhook` branches internally on the
  // token header vs signature header.
  //
  // Routing: one bot per daemon means we short-circuit to the single workspace
  // with a `discord` signal. If multiple workspaces have one, we log-warn and
  // pick the first — proper multi-workspace routing is a separate task.
  app.post("/discord", async (c) => {
    const discordRequest = c.req.raw.clone();

    const candidates = await listWorkspacesByProvider(daemon, "discord");
    if (candidates.length === 0) {
      logger.warn("discord_no_workspace");
      return c.json({ error: "No workspace configured for Discord" }, 404);
    }
    if (candidates.length > 1) {
      logger.warn("discord_multiple_workspaces_ambiguous", { candidates, picked: candidates[0] });
    }
    const workspaceId = candidates[0];
    if (!workspaceId) {
      return c.json({ error: "No workspace configured for Discord" }, 404);
    }

    logger.info("discord_signal_received", { workspaceId });

    return delegateToWebhook(c, daemon, "discord", workspaceId, discordRequest);
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

    // Resolution priority:
    //   1. Link wiring — workspace.yml carries `{ kind: telegram }` only and
    //      Link's communicator_wiring table maps the URL suffix
    //      (`connection_id`) to a workspace. Single-call atomic lookup.
    //   2. Legacy yml/env paths — workspaces with inline `bot_token` under
    //      `signals.telegram.config` or env-var single-bot setups.
    let workspaceId: string | null = null;
    if (tokenSuffix) {
      const resolved = await resolveCommunicatorByConnection(tokenSuffix, "telegram").catch(
        (error) => {
          logger.warn("telegram_link_resolve_failed", {
            error: error instanceof Error ? error.message : String(error),
          });
          return null;
        },
      );
      if (resolved) workspaceId = resolved.workspaceId;
    }
    workspaceId ??=
      (tokenSuffix ? await findTelegramWorkspaceBySuffix(daemon, tokenSuffix) : null) ??
      (await findWorkspaceByProvider(daemon, "telegram"));

    if (!workspaceId) {
      logger.warn("telegram_no_workspace", { tokenSuffixPresent: !!tokenSuffix });
      return c.json({ error: "No workspace configured for Telegram" }, 404);
    }

    logger.info("telegram_signal_received", { workspaceId, tokenSuffixPresent: !!tokenSuffix });

    return delegateToWebhook(c, daemon, "telegram", workspaceId, telegramRequest, {
      tokenSuffixPresent: !!tokenSuffix,
    });
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

    return delegateToWebhook(c, daemon, "whatsapp", workspaceId, whatsappRequest, {
      phoneNumberId,
    });
  });

  // ─── Microsoft Teams ──────────────────────────────────────────────
  // Azure Bot messaging endpoint: https://<tunnel>/platform/teams → /signals/teams.
  // The adapter validates JWTs against login.botframework.com internally, so
  // atlasd just routes by `activity.recipient.id` (formatted "28:<botAppId>")
  // and forwards the raw request. No GET handshake, no signature header check.
  app.post("/teams", async (c) => {
    // Clone before consuming — the adapter needs the raw body for JWT validation
    const teamsRequest = c.req.raw.clone();
    const rawBody = await c.req.text();

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      logger.warn("teams_signal_invalid_json", { bodyPreview: rawBody.slice(0, 200) });
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const routing = TeamsRoutingPayloadSchema.safeParse(parsed);
    if (!routing.success) {
      logger.warn("teams_signal_missing_recipient", { bodyPreview: rawBody.slice(0, 200) });
      return c.json({ error: "Missing recipient.id in payload" }, 400);
    }

    const recipientId = routing.data.recipient.id;
    const appId = recipientId.startsWith("28:") ? recipientId.slice(3) : recipientId;

    let workspaceId = await findWorkspaceByProvider(daemon, "teams", "app_id", appId);
    if (!workspaceId) {
      // Env-only fallback: a workspace with a teams signal but no `app_id` in
      // workspace.yml reads TEAMS_APP_ID from env and is a valid delivery
      // target for any Teams activity. Workspaces that DID pin `app_id` are
      // not candidates — if they pinned X and the activity carries Y, a
      // silent delivery would mask the operator's config typo. Fail closed.
      const envOnlyCandidates = await listWorkspacesByProviderWithoutConfigKey(
        daemon,
        "teams",
        "app_id",
      );
      if (envOnlyCandidates.length > 1) {
        logger.warn("teams_env_only_ambiguous_fallback", {
          appId,
          candidates: envOnlyCandidates,
          picked: envOnlyCandidates[0],
        });
      }
      workspaceId = envOnlyCandidates[0] ?? null;
    }

    if (!workspaceId) {
      logger.warn("teams_no_workspace_for_app_id", { appId });
      return c.json({ error: "No workspace configured for this app_id" }, 404);
    }

    logger.info("teams_signal_received", { workspaceId, appId });

    return delegateToWebhook(c, daemon, "teams", workspaceId, teamsRequest, { appId });
  });

  return app;
}

/**
 * Find a workspace whose signal config matches a provider and optional
 * config key/value. Without a `configKey`, also accepts a top-level
 * `communicators[provider]` declaration — the new yml shape carries
 * `{ kind: <provider> }` with no inline config, so the configKey/value
 * branch only applies to the legacy `signals.<x>.config` path.
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

    if (!configKey && config.workspace.communicators) {
      for (const entry of Object.values(config.workspace.communicators)) {
        if (entry?.kind === provider) return ws.id;
      }
    }

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
 * Return every workspace id that has a signal with the given provider where
 * the signal's config does NOT set `configKey`. Used for env-only fallback:
 * a workspace that omits `app_id`/`bot_token`/etc. from workspace.yml reads
 * the value from env and is a legitimate wildcard match when incoming-event
 * routing misses the exact-match lookup.
 */
async function listWorkspacesByProviderWithoutConfigKey(
  daemon: AtlasDaemon,
  provider: string,
  configKey: string,
): Promise<string[]> {
  const workspaces = await daemon.getWorkspaceManager().list();
  const matches: string[] = [];

  for (const ws of workspaces) {
    const config = await daemon.getWorkspaceManager().getWorkspaceConfig(ws.id);
    const signals = config?.workspace.signals;
    if (!signals) continue;

    for (const signal of Object.values(signals)) {
      if (signal?.provider !== provider) continue;
      const cfg = "config" in signal ? signal.config : undefined;
      const rawValue = cfg && typeof cfg === "object" ? Reflect.get(cfg, configKey) : undefined;
      const hasKey = typeof rawValue === "string" && rawValue.length > 0;
      if (!hasKey) {
        matches.push(ws.id);
        break;
      }
    }
  }

  return matches;
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
