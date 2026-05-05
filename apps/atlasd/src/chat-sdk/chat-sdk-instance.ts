/**
 * Per-workspace Chat SDK instance lifecycle. Wires the adapter factory,
 * ChatSdkStateAdapter, signalToStream bridge, and the shared message handler
 * that fires the "chat" signal.
 */
import process from "node:process";
import type { AtlasUIMessage } from "@atlas/agent-sdk";
import {
  SlackProviderConfigSchema,
  TeamsProviderConfigSchema,
  TelegramProviderConfigSchema,
  WhatsAppProviderConfigSchema,
} from "@atlas/config";
import { ChatSdkStateAdapter } from "@atlas/core/chat/chat-sdk-state-adapter";
import { ChatStorage } from "@atlas/core/chat/storage";
import { fetchLinkCredential } from "@atlas/core/mcp-registry/credential-resolver";
import { createLogger } from "@atlas/logger";
import { signalToStream, type TriggerFn } from "@atlas/workspace/signal-to-stream";
import type { Message, StreamEvent, Thread } from "chat";
import { Chat } from "chat";
import { z } from "zod";
import type { ChatTurnRegistry } from "../chat-turn-registry.ts";
import { KERNEL_WORKSPACE_ID } from "../factory.ts";
import {
  findCommunicatorWiring,
  TelegramCredentialSecretSchema,
} from "../services/communicator-wiring.ts";
import { isClientSafeEvent } from "../stream-event-filter.ts";
import type { StreamRegistry } from "../stream-registry.ts";
import {
  buildChatSdkAdapters,
  type CommunicatorEntry,
  type PlatformCredentials,
} from "./adapter-factory.ts";
import { ChatSdkNotifier } from "./chat-sdk-notifier.ts";

const logger = createLogger({ component: "chat-sdk-instance" });

/**
 * Full credential-secret shapes as stored in Link, used by the daemon's
 * Link-first credential resolvers. These mirror the per-provider schemas in
 * `apps/link/src/providers/*.ts` (`DiscordSecretSchema`, `TeamsSecretSchema`,
 * `WhatsappSecretSchema` + post-`autoFields` `verify_token`). They're kept
 * separate from the routing-key-only schemas in `communicator-wiring.ts`
 * (`DiscordCredentialSecretSchema` etc.) which only assert the field used as
 * `connection_id` — those exist for `deriveConnectionId` and would silently
 * accept partial secrets here.
 */
const DiscordLinkSecretSchema = z.object({
  bot_token: z.string().min(1),
  public_key: z.string().min(1),
  application_id: z.string().min(1),
});

const TeamsLinkSecretSchema = z.object({
  app_id: z.string().min(1),
  app_password: z.string().min(1),
  app_tenant_id: z.string().min(1),
  app_type: z.enum(["MultiTenant", "SingleTenant"]),
});

// `verify_token` is generated server-side by Link's `autoFields` hook at
// credential creation time — it's always present in the stored secret, so
// the daemon-side parser requires it (mismatched name = signature
// verification failure on inbound Meta webhooks).
const WhatsappLinkSecretSchema = z.object({
  access_token: z.string().min(1),
  app_secret: z.string().min(1),
  phone_number_id: z.string().min(1),
  verify_token: z.string().min(1),
});

const SlackLinkSecretSchema = z.object({
  bot_token: z.string().min(1),
  signing_secret: z.string().min(1),
  app_id: z.string().min(1),
});

export interface ChatSdkInstanceConfig {
  workspaceId: string;
  userId: string;
  signals?: Record<string, { provider?: string; config?: Record<string, unknown> }>;
  communicators?: Record<string, CommunicatorEntry>;
  streamRegistry: StreamRegistry;
  chatTurnRegistry?: ChatTurnRegistry;
  triggerFn: TriggerFn;
  exposeKernel?: boolean;
}

export interface ChatSdkInstance {
  chat: Chat;
  notifier: ChatSdkNotifier;
  /** Map keyed by adapter kind ("slack" | "telegram" | ...) → platform-native default destination. */
  broadcastDestinations: Record<string, string>;
  teardown: () => Promise<void>;
}

export interface ResolvedCredentials {
  credentials: PlatformCredentials;
  credentialId: string;
}

/**
 * Picks the config object for a given chat-adapter kind, preferring the
 * top-level `communicators` map over signals. When the kind is declared in
 * both, the communicators entry wins. The duplicate-declaration warn fires
 * once per workspace at adapter-factory startup (see `findChatProviders`
 * → `platform_adapter_duplicate_declaration`); we deliberately don't repeat
 * the warn here because this helper is called multiple times per workspace
 * (credential resolver + broadcast destination collector + per-platform
 * lookups), and re-warning each time would spam logs without surfacing new
 * info. Returns `null` when the kind is not declared anywhere.
 */
function pickConfigForKind(
  kind: string,
  signals: Record<string, { provider?: string; config?: Record<string, unknown> }>,
  communicators: Record<string, CommunicatorEntry> | undefined,
): Record<string, unknown> | null {
  if (communicators) {
    for (const entry of Object.values(communicators)) {
      if (entry?.kind === kind) {
        const { kind: _kind, ...rest } = entry;
        return rest;
      }
    }
  }
  for (const signal of Object.values(signals)) {
    if (signal?.provider === kind) {
      return signal.config ?? {};
    }
  }
  return null;
}

/**
 * Build the per-kind default-destination map for the broadcast hook. Walks
 * the same precedence path as `pickConfigForKind` (communicators wins, signals
 * fall back) for each chat provider and pulls out `default_destination` when
 * present. Kinds without a destination are simply absent from the map; the
 * broadcaster skips them at send time.
 */
function collectBroadcastDestinations(
  signals: Record<string, { provider?: string; config?: Record<string, unknown> }> | undefined,
  communicators: Record<string, CommunicatorEntry> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const kind of ["slack", "telegram", "discord", "teams", "whatsapp"] as const) {
    const config = pickConfigForKind(kind, signals ?? {}, communicators);
    const dest =
      config && typeof config.default_destination === "string" ? config.default_destination : null;
    if (dest) out[kind] = dest;
  }
  return out;
}

/**
 * Resolve every platform credential a workspace has wired. Each provider is
 * resolved independently from a single config block — drawn from the top-level
 * `communicators` map first, then from a matching signal's `config` — plus env
 * vars. The Link service is consulted for the five apikey communicators
 * (Slack, Telegram, Discord, Teams, WhatsApp) via the `communicator_wiring`
 * table. Resolution priority for all five is: Link → yml inline → env var;
 * the latter two stay as backward-compat fallbacks for env-only and BYO-token
 * setups.
 */
export async function resolvePlatformCredentials(
  workspaceId: string,
  userId: string,
  signals: Record<string, { provider?: string; config?: Record<string, unknown> }>,
  communicators?: Record<string, CommunicatorEntry>,
): Promise<ResolvedCredentials[]> {
  const resolved: ResolvedCredentials[] = [];

  const telegramConfig = pickConfigForKind("telegram", signals, communicators);
  if (telegramConfig) {
    const creds = await resolveTelegramCredentials(workspaceId, userId, telegramConfig);
    if (creds) resolved.push(creds);
  }

  const whatsappConfig = pickConfigForKind("whatsapp", signals, communicators);
  if (whatsappConfig) {
    const creds = await resolveWhatsappCredentials(workspaceId, userId, whatsappConfig);
    if (creds) resolved.push(creds);
  }

  const discordConfig = pickConfigForKind("discord", signals, communicators);
  if (discordConfig) {
    const creds = await resolveDiscordCredentials(workspaceId, userId, discordConfig);
    if (creds) resolved.push(creds);
  }

  const teamsConfig = pickConfigForKind("teams", signals, communicators);
  if (teamsConfig) {
    const creds = await resolveTeamsCredentials(workspaceId, userId, teamsConfig);
    if (creds) resolved.push(creds);
  }

  const slackConfig = pickConfigForKind("slack", signals, communicators);
  if (slackConfig) {
    const creds = await resolveSlackCredentials(workspaceId, userId, slackConfig);
    if (creds) resolved.push(creds);
  }

  return resolved;
}

/**
 * Resolve Telegram credentials in priority order:
 * 1. Link wiring (`communicator_wiring` table → credential secret) — preferred,
 *    workspace.yml carries `{ kind: telegram }` only and Link owns the secrets.
 * 2. yml inline — legacy BYO-token setups where workspace.yml stashes
 *    `bot_token` directly under the signal/communicator config.
 * 3. `TELEGRAM_BOT_TOKEN` / `TELEGRAM_WEBHOOK_SECRET` env vars — single-bot
 *    dev setups.
 */
async function resolveTelegramCredentials(
  workspaceId: string,
  userId: string,
  config: Record<string, unknown>,
): Promise<ResolvedCredentials | null> {
  const linkCreds = await resolveTelegramFromLink(workspaceId, userId);
  if (linkCreds) return linkCreds;

  const parsed = TelegramProviderConfigSchema.safeParse(config);
  if (!parsed.success) {
    logger.debug("telegram_invalid_config", { error: parsed.error.message });
    return null;
  }

  const botToken = parsed.data.bot_token ?? process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
    logger.debug("telegram_no_bot_token", {
      hint: "Set bot_token in config or TELEGRAM_BOT_TOKEN env var",
    });
    return null;
  }

  const webhookSecret = parsed.data.webhook_secret ?? process.env.TELEGRAM_WEBHOOK_SECRET ?? "";

  return {
    credentials: {
      kind: "telegram",
      botToken,
      secretToken: webhookSecret,
      appId: botToken.split(":")[0] ?? "",
    },
    credentialId: `telegram:${botToken.split(":")[0]}`,
  };
}

/**
 * Look up the workspace's Telegram wiring in Link. Returns null on no wiring,
 * pending credential, or transient Link errors — those fall through to the
 * legacy yml/env paths instead of failing loudly. A 5xx from Link should not
 * disable a workspace whose secrets could be served from yml.
 */
async function resolveTelegramFromLink(
  workspaceId: string,
  userId: string,
): Promise<ResolvedCredentials | null> {
  let wiring: { credentialId: string; connectionId: string | null } | null;
  try {
    wiring = await findCommunicatorWiring(workspaceId, "telegram");
  } catch (error) {
    logger.warn("telegram_link_wiring_lookup_failed", {
      workspaceId,
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }

  if (!wiring) return null;

  let credential: Awaited<ReturnType<typeof fetchLinkCredential>>;
  try {
    credential = await fetchLinkCredential(wiring.credentialId, logger);
  } catch (error) {
    logger.warn("telegram_link_credential_fetch_failed", {
      workspaceId,
      userId,
      credentialId: wiring.credentialId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }

  const secretParse = TelegramCredentialSecretSchema.safeParse(credential.secret);
  if (!secretParse.success) {
    logger.warn("telegram_link_credential_invalid_secret", {
      workspaceId,
      credentialId: wiring.credentialId,
      issues: secretParse.error.issues,
    });
    return null;
  }

  const { bot_token, webhook_secret } = secretParse.data;
  return {
    credentials: {
      kind: "telegram",
      botToken: bot_token,
      secretToken: webhook_secret,
      appId: bot_token.split(":")[0] ?? "",
    },
    credentialId: wiring.credentialId,
  };
}

/**
 * Resolve WhatsApp credentials in priority order:
 * 1. Link wiring (`communicator_wiring` table → credential secret) — preferred,
 *    workspace.yml carries `{ kind: whatsapp }` only and Link owns the secrets.
 * 2. yml inline — legacy BYO-token setups where workspace.yml stashes
 *    `access_token` / `app_secret` / `phone_number_id` / `verify_token`
 *    directly under the signal/communicator config.
 * 3. `WHATSAPP_*` env vars — single-bot dev setups.
 */
async function resolveWhatsappCredentials(
  workspaceId: string,
  userId: string,
  config: Record<string, unknown>,
): Promise<ResolvedCredentials | null> {
  const linkCreds = await resolveWhatsappFromLink(workspaceId, userId);
  if (linkCreds) return linkCreds;

  const parsed = WhatsAppProviderConfigSchema.safeParse(config);
  if (!parsed.success) {
    logger.debug("whatsapp_invalid_config", { error: parsed.error.message });
    return null;
  }

  const accessToken = parsed.data.access_token ?? process.env.WHATSAPP_ACCESS_TOKEN;
  const appSecret = parsed.data.app_secret ?? process.env.WHATSAPP_APP_SECRET;
  const phoneNumberId = parsed.data.phone_number_id ?? process.env.WHATSAPP_PHONE_NUMBER_ID;
  const verifyToken = parsed.data.verify_token ?? process.env.WHATSAPP_VERIFY_TOKEN;

  if (!accessToken || !appSecret || !phoneNumberId || !verifyToken) {
    const missing: string[] = [];
    if (!accessToken) missing.push("access_token / WHATSAPP_ACCESS_TOKEN");
    if (!appSecret) missing.push("app_secret / WHATSAPP_APP_SECRET");
    if (!phoneNumberId) missing.push("phone_number_id / WHATSAPP_PHONE_NUMBER_ID");
    if (!verifyToken) missing.push("verify_token / WHATSAPP_VERIFY_TOKEN");
    logger.debug("whatsapp_missing_credentials", { missing });
    return null;
  }

  return {
    credentials: { kind: "whatsapp", accessToken, appSecret, phoneNumberId, verifyToken },
    credentialId: `whatsapp:${phoneNumberId}`,
  };
}

/**
 * Look up the workspace's WhatsApp wiring in Link. Returns null on no wiring,
 * invalid stored secret, or transient Link errors — those fall through to the
 * legacy yml/env paths instead of failing loudly. A 5xx from Link should not
 * disable a workspace whose secrets could be served from yml.
 */
async function resolveWhatsappFromLink(
  workspaceId: string,
  userId: string,
): Promise<ResolvedCredentials | null> {
  let wiring: { credentialId: string; connectionId: string | null } | null;
  try {
    wiring = await findCommunicatorWiring(workspaceId, "whatsapp");
  } catch (error) {
    logger.warn("whatsapp_link_wiring_lookup_failed", {
      workspaceId,
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }

  if (!wiring) return null;

  let credential: Awaited<ReturnType<typeof fetchLinkCredential>>;
  try {
    credential = await fetchLinkCredential(wiring.credentialId, logger);
  } catch (error) {
    logger.warn("whatsapp_link_credential_fetch_failed", {
      workspaceId,
      userId,
      credentialId: wiring.credentialId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }

  const secretParse = WhatsappLinkSecretSchema.safeParse(credential.secret);
  if (!secretParse.success) {
    logger.warn("whatsapp_link_credential_invalid_secret", {
      workspaceId,
      credentialId: wiring.credentialId,
      issues: secretParse.error.issues,
    });
    return null;
  }

  const { access_token, app_secret, phone_number_id, verify_token } = secretParse.data;
  return {
    credentials: {
      kind: "whatsapp",
      accessToken: access_token,
      appSecret: app_secret,
      phoneNumberId: phone_number_id,
      verifyToken: verify_token,
    },
    credentialId: wiring.credentialId,
  };
}

/**
 * Resolves the per-workspace Discord credentials. The resulting `DiscordAdapter`
 * (built by `buildChatSdkAdapters`) is used for **inbound forwarded Gateway
 * events** (via `chat.webhooks.discord` on `/signals/discord` POSTs) and
 * **outbound `postMessage`** replies. It does NOT own a Gateway connection —
 * that's the daemon-scoped `DiscordGatewayService`'s job.
 *
 * Resolution priority:
 * 1. Link wiring (`communicator_wiring` table → credential secret) — preferred,
 *    workspace.yml carries `{ kind: discord }` only and Link owns the secrets.
 * 2. yml inline — legacy BYO-token setups where workspace.yml stashes
 *    `bot_token` / `public_key` / `application_id` directly under the
 *    signal/communicator config.
 * 3. `DISCORD_*` env vars — single-bot dev setups.
 */
export async function resolveDiscordCredentials(
  workspaceId: string,
  userId: string,
  config: Record<string, unknown>,
): Promise<ResolvedCredentials | null> {
  const linkCreds = await resolveDiscordFromLink(workspaceId, userId);
  if (linkCreds) return linkCreds;

  const botToken =
    (typeof config.bot_token === "string" ? config.bot_token : null) ??
    process.env.DISCORD_BOT_TOKEN;
  const publicKey =
    (typeof config.public_key === "string" ? config.public_key : null) ??
    process.env.DISCORD_PUBLIC_KEY;
  const applicationId =
    (typeof config.application_id === "string" ? config.application_id : null) ??
    process.env.DISCORD_APPLICATION_ID;

  if (!botToken || !publicKey || !applicationId) {
    const missing: string[] = [];
    if (!botToken) missing.push("bot_token / DISCORD_BOT_TOKEN");
    if (!publicKey) missing.push("public_key / DISCORD_PUBLIC_KEY");
    if (!applicationId) missing.push("application_id / DISCORD_APPLICATION_ID");
    logger.debug("discord_missing_credentials", { missing });
    return null;
  }

  return {
    credentials: { kind: "discord", botToken, publicKey, applicationId },
    credentialId: `discord:${applicationId}`,
  };
}

/**
 * Look up the workspace's Discord wiring in Link. Returns null on no wiring,
 * invalid stored secret, or transient Link errors — those fall through to the
 * legacy yml/env paths instead of failing loudly. A 5xx from Link should not
 * disable a workspace whose secrets could be served from yml.
 */
async function resolveDiscordFromLink(
  workspaceId: string,
  userId: string,
): Promise<ResolvedCredentials | null> {
  let wiring: { credentialId: string; connectionId: string | null } | null;
  try {
    wiring = await findCommunicatorWiring(workspaceId, "discord");
  } catch (error) {
    logger.warn("discord_link_wiring_lookup_failed", {
      workspaceId,
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }

  if (!wiring) return null;

  let credential: Awaited<ReturnType<typeof fetchLinkCredential>>;
  try {
    credential = await fetchLinkCredential(wiring.credentialId, logger);
  } catch (error) {
    logger.warn("discord_link_credential_fetch_failed", {
      workspaceId,
      userId,
      credentialId: wiring.credentialId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }

  const secretParse = DiscordLinkSecretSchema.safeParse(credential.secret);
  if (!secretParse.success) {
    logger.warn("discord_link_credential_invalid_secret", {
      workspaceId,
      credentialId: wiring.credentialId,
      issues: secretParse.error.issues,
    });
    return null;
  }

  const { bot_token, public_key, application_id } = secretParse.data;
  return {
    credentials: {
      kind: "discord",
      botToken: bot_token,
      publicKey: public_key,
      applicationId: application_id,
    },
    credentialId: wiring.credentialId,
  };
}

/**
 * Resolve Teams credentials in priority order:
 * 1. Link wiring (`communicator_wiring` table → credential secret) — preferred,
 *    workspace.yml carries `{ kind: teams }` only and Link owns the secrets.
 * 2. yml inline — legacy BYO-token setups where workspace.yml stashes
 *    `app_id` / `app_password` / `app_tenant_id` / `app_type` directly under
 *    the signal/communicator config.
 * 3. `TEAMS_*` env vars — single-bot dev setups.
 */
async function resolveTeamsCredentials(
  workspaceId: string,
  userId: string,
  config: Record<string, unknown>,
): Promise<ResolvedCredentials | null> {
  const linkCreds = await resolveTeamsFromLink(workspaceId, userId);
  if (linkCreds) return linkCreds;

  const parsed = TeamsProviderConfigSchema.safeParse(config);
  if (!parsed.success) {
    logger.debug("teams_invalid_config", { error: parsed.error.message });
    return null;
  }

  const appId = parsed.data.app_id ?? process.env.TEAMS_APP_ID;
  const appPassword = parsed.data.app_password ?? process.env.TEAMS_APP_PASSWORD;
  const appTenantId = parsed.data.app_tenant_id ?? process.env.TEAMS_APP_TENANT_ID;
  // appType also has an env fallback so env-only SingleTenant setups work
  // without a workspace.yml config block — otherwise the default
  // (MultiTenant) silently wins and JWT validation fails against the wrong
  // issuer. Only log when TEAMS_APP_TYPE is set-but-invalid (unset is the
  // normal case and would otherwise spam debug logs on every workspace load).
  const rawEnvAppType = process.env.TEAMS_APP_TYPE;
  let envAppType: "MultiTenant" | "SingleTenant" | undefined;
  if (rawEnvAppType === "MultiTenant" || rawEnvAppType === "SingleTenant") {
    envAppType = rawEnvAppType;
  } else if (rawEnvAppType !== undefined) {
    logger.debug("teams_invalid_env_app_type", { value: rawEnvAppType });
  }
  const appType = parsed.data.app_type ?? envAppType;

  const requiresTenantId = appType === "SingleTenant";

  if (!appId || !appPassword || (requiresTenantId && !appTenantId)) {
    const missing: string[] = [];
    if (!appId) missing.push("app_id / TEAMS_APP_ID");
    if (!appPassword) missing.push("app_password / TEAMS_APP_PASSWORD");
    if (requiresTenantId && !appTenantId) {
      missing.push("app_tenant_id / TEAMS_APP_TENANT_ID (required for SingleTenant)");
    }
    logger.debug("teams_missing_credentials", { missing });
    return null;
  }

  return {
    credentials: {
      kind: "teams",
      appId,
      appPassword,
      ...(appTenantId ? { appTenantId } : {}),
      ...(appType ? { appType } : {}),
    },
    credentialId: `teams:${appId}`,
  };
}

/**
 * Look up the workspace's Teams wiring in Link. Returns null on no wiring,
 * invalid stored secret, or transient Link errors — those fall through to the
 * legacy yml/env paths instead of failing loudly. A 5xx from Link should not
 * disable a workspace whose secrets could be served from yml.
 */
async function resolveTeamsFromLink(
  workspaceId: string,
  userId: string,
): Promise<ResolvedCredentials | null> {
  let wiring: { credentialId: string; connectionId: string | null } | null;
  try {
    wiring = await findCommunicatorWiring(workspaceId, "teams");
  } catch (error) {
    logger.warn("teams_link_wiring_lookup_failed", {
      workspaceId,
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }

  if (!wiring) return null;

  let credential: Awaited<ReturnType<typeof fetchLinkCredential>>;
  try {
    credential = await fetchLinkCredential(wiring.credentialId, logger);
  } catch (error) {
    logger.warn("teams_link_credential_fetch_failed", {
      workspaceId,
      userId,
      credentialId: wiring.credentialId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }

  const secretParse = TeamsLinkSecretSchema.safeParse(credential.secret);
  if (!secretParse.success) {
    logger.warn("teams_link_credential_invalid_secret", {
      workspaceId,
      credentialId: wiring.credentialId,
      issues: secretParse.error.issues,
    });
    return null;
  }

  const { app_id, app_password, app_tenant_id, app_type } = secretParse.data;
  return {
    credentials: {
      kind: "teams",
      appId: app_id,
      appPassword: app_password,
      appTenantId: app_tenant_id,
      appType: app_type,
    },
    credentialId: wiring.credentialId,
  };
}

/**
 * Resolve Slack credentials in priority order:
 * 1. Link wiring (`communicator_wiring` table → credential secret) — preferred,
 *    workspace.yml carries `{ kind: slack }` only and Link owns the secrets.
 * 2. yml inline — legacy BYO-token setups where workspace.yml stashes
 *    `bot_token` / `signing_secret` / `app_id` directly under the
 *    signal/communicator config.
 * 3. `SLACK_*` env vars — single-bot dev setups.
 */
async function resolveSlackCredentials(
  workspaceId: string,
  userId: string,
  config: Record<string, unknown>,
): Promise<ResolvedCredentials | null> {
  const linkCreds = await resolveSlackFromLink(workspaceId, userId);
  if (linkCreds) return linkCreds;

  const parsed = SlackProviderConfigSchema.safeParse(config);
  if (!parsed.success) {
    logger.debug("slack_invalid_config", { error: parsed.error.message });
    return null;
  }

  const botToken = parsed.data.bot_token ?? process.env.SLACK_BOT_TOKEN;
  if (!botToken) {
    logger.debug("slack_no_bot_token", {
      hint: "Set bot_token in config or SLACK_BOT_TOKEN env var",
    });
    return null;
  }

  const signingSecret = parsed.data.signing_secret ?? process.env.SLACK_SIGNING_SECRET;
  if (!signingSecret) {
    logger.debug("slack_no_signing_secret", {
      hint: "Set signing_secret in config or SLACK_SIGNING_SECRET env var",
    });
    return null;
  }

  const appId = parsed.data.app_id ?? process.env.SLACK_APP_ID ?? "";

  return {
    credentials: { kind: "slack", botToken, signingSecret, appId },
    credentialId: appId ? `slack:${appId}` : `slack:${botToken.slice(-8)}`,
  };
}

/**
 * Look up the workspace's Slack wiring in Link. Returns null on no wiring,
 * invalid stored secret, or transient Link errors — those fall through to the
 * legacy yml/env paths instead of failing loudly. A 5xx from Link should not
 * disable a workspace whose secrets could be served from yml.
 */
async function resolveSlackFromLink(
  workspaceId: string,
  userId: string,
): Promise<ResolvedCredentials | null> {
  let wiring: { credentialId: string; connectionId: string | null } | null;
  try {
    wiring = await findCommunicatorWiring(workspaceId, "slack");
  } catch (error) {
    logger.warn("slack_link_wiring_lookup_failed", {
      workspaceId,
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }

  if (!wiring) return null;

  let credential: Awaited<ReturnType<typeof fetchLinkCredential>>;
  try {
    credential = await fetchLinkCredential(wiring.credentialId, logger);
  } catch (error) {
    logger.warn("slack_link_credential_fetch_failed", {
      workspaceId,
      userId,
      credentialId: wiring.credentialId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }

  const secretParse = SlackLinkSecretSchema.safeParse(credential.secret);
  if (!secretParse.success) {
    logger.warn("slack_link_credential_invalid_secret", {
      workspaceId,
      credentialId: wiring.credentialId,
      issues: secretParse.error.issues,
    });
    return null;
  }

  const { bot_token, signing_secret, app_id } = secretParse.data;
  return {
    credentials: {
      kind: "slack",
      botToken: bot_token,
      signingSecret: signing_secret,
      appId: app_id,
    },
    credentialId: wiring.credentialId,
  };
}

const MAX_LOG_FIELD_BYTES = 512;

function truncateForLog(value: unknown): string {
  const str = typeof value === "string" ? value : (JSON.stringify(value) ?? String(value));
  return str.length > MAX_LOG_FIELD_BYTES
    ? `${str.slice(0, MAX_LOG_FIELD_BYTES)}…[truncated]`
    : str;
}

function toAtlasUIMessage(message: Message): AtlasUIMessage {
  return {
    id: message.id,
    role: "user" as const,
    parts: [{ type: "text" as const, text: message.text }],
    metadata: {},
  };
}

/**
 * Schema used to retrieve a pre-validated `AtlasUIMessage` that an adapter
 * stashed on `Message.raw.uiMessage` (see `AtlasWebAdapter`). This preserves
 * non-text parts (`data-artifact-attached`, etc.) that the flat `Message.text`
 * field cannot carry. `z.custom` trusts the boundary validation already
 * performed at the adapter — we only assert enough shape here to safely pass
 * through to `ChatStorage.appendMessage`.
 */
const preValidatedUIMessageRawSchema = z.object({
  uiMessage: z.custom<AtlasUIMessage>((val) => {
    if (typeof val !== "object" || val === null) return false;
    if (!("parts" in val)) return false;
    return Array.isArray(val.parts);
  }),
});

/**
 * Shared handler registered on `chat.onNewMention` and `chat.onSubscribedMessage`.
 * Subscribes the thread, appends the user message, then fires the "chat"
 * signal — events go to StreamRegistry via the tap (for web SSE) and to
 * `thread.post()` for platform adapters.
 */
export function createMessageHandler(
  workspaceId: string,
  triggerFn: TriggerFn,
  streamRegistry: StreamRegistry,
  stateAdapter?: ChatSdkStateAdapter,
  options?: { exposeKernel?: boolean },
): (thread: Thread, message: Message) => Promise<void> {
  return async (thread: Thread, message: Message): Promise<void> => {
    const adapterName = thread.adapter.name;
    const sourceWasSet =
      stateAdapter &&
      (adapterName === "slack" ||
        adapterName === "discord" ||
        adapterName === "telegram" ||
        adapterName === "whatsapp" ||
        adapterName === "teams");
    if (sourceWasSet) {
      stateAdapter.setSource(thread.id, adapterName);
    }
    try {
      await thread.subscribe();
    } catch (err) {
      // The pre-set source is normally consumed inside stateAdapter.subscribe.
      // If thread.subscribe() throws before reaching that point, drop the
      // entry ourselves so it doesn't leak.
      if (sourceWasSet) {
        stateAdapter.clearSource(thread.id);
      }
      throw err;
    }

    if (adapterName === "slack") {
      thread.adapter.addReaction(thread.id, message.id, "eyes").catch((err: unknown) => {
        logger.warn("acknowledgment_reaction_failed", { threadId: thread.id, error: err });
      });
    }

    const chatId = thread.id;
    const userId = message.author.userId;
    const streamId = chatId;

    // Prefer the adapter-stashed pre-validated AtlasUIMessage (carries
    // non-text parts); fall back to the flat-text rebuild for adapters that
    // only provide `Message.text` (e.g. Slack).
    const preValidated = preValidatedUIMessageRawSchema.safeParse(message.raw);
    const storedMessage = preValidated.success
      ? preValidated.data.uiMessage
      : toAtlasUIMessage(message);

    const appendResult = await ChatStorage.appendMessage(chatId, storedMessage, workspaceId);
    if (!appendResult.ok) {
      logger.error("chat_sdk_append_message_failed", {
        chatId,
        workspaceId,
        error: appendResult.error,
      });
    }

    const datetime =
      typeof message.raw === "object" && message.raw !== null && "datetime" in message.raw
        ? message.raw.datetime
        : undefined;

    // The atlas web adapter stashes the per-turn abort signal on the raw
    // payload (sourced from ChatTurnRegistry). Other adapters (Slack, Telegram)
    // don't currently set this — they get undefined, which means no per-turn
    // abort, matching their existing behavior. Validate the runtime shape
    // because Message.raw is `unknown` here.
    const abortSignal =
      typeof message.raw === "object" &&
      message.raw !== null &&
      "abortSignal" in message.raw &&
      message.raw.abortSignal instanceof AbortSignal
        ? message.raw.abortSignal
        : undefined;

    const rawFgPayload =
      typeof message.raw === "object" &&
      message.raw !== null &&
      "foregroundWorkspaceIds" in message.raw
        ? message.raw.foregroundWorkspaceIds
        : undefined;
    const foregroundWorkspaceIds = Array.isArray(rawFgPayload)
      ? rawFgPayload
          .filter((id: unknown): id is string => typeof id === "string")
          .filter((id) => options?.exposeKernel || id !== KERNEL_WORKSPACE_ID)
      : undefined;

    // Capture the buffer this turn owns so stale producers can't bleed into
    // a follow-up turn's buffer. The web adapter creates the buffer in
    // `handleWebhook` before dispatching here; non-web adapters (Slack etc.)
    // never create one and `getStream` returns undefined — appendEvent then
    // returns false silently for those, matching prior behavior. Without this
    // capture, a late event from an aborted turn would land in the next
    // turn's buffer (same chatId key) and arrive at the UI without a matching
    // `text-start`, tripping the AI SDK validator with a "text delta error".
    const ownBuffer = streamRegistry.getStream(chatId);

    // signalToStream fans events two ways: the tap pushes ALL client-safe
    // events to StreamRegistry for the full web SSE stream, while the async
    // iterable feeds thread.post() → fromFullStream for platform adapters
    // (Slack), which only get text — fromFullStream drops tool/reasoning/data-*.
    const stream = signalToStream<StreamEvent>(
      triggerFn,
      "chat",
      { chatId, userId, streamId, datetime, foregroundWorkspaceIds },
      streamId,
      (chunk: unknown) => {
        if (isClientSafeEvent(chunk)) {
          const appended = streamRegistry.appendEvent(chatId, chunk, ownBuffer);
          if (!appended) {
            logger.warn("stream_event_dropped", {
              chatId,
              chunkType:
                typeof chunk === "object" && chunk !== null && "type" in chunk
                  ? String(chunk.type)
                  : "unknown",
            });
          }
        }
      },
      abortSignal,
    );

    try {
      await thread.post(stream);
    } catch (error) {
      // Surface adapter-side post failures (e.g. Meta Graph API errors).
      // Without this the stream silently swallows the error and the user
      // sees no reply on their platform. Keep the first handful of stack
      // frames to group by call site; the adapter's own error
      // message carries the provider-specific code (e.g. fbtrace_id on
      // Meta, Slack error types) — docs/integrations/<provider>/README.md
      // maps common codes to fixes.
      const stack =
        error instanceof Error && error.stack
          ? error.stack.split("\n").slice(0, 8).join("\n")
          : undefined;
      // Axios errors stash the outbound URL + response on the error object.
      // Capture them when present so Teams / Slack 4xx responses carry the
      // provider-side error code (e.g. `ServiceUnavailable`, `MsaUserNotFound`)
      // up to ops without having to reproduce the failure under a debugger.
      //
      // `response.data` is truncated: Bot Framework / Slack / Meta return small
      // JSON errors, but a misconfigured proxy or Cloudflare 502 in front of
      // those endpoints can return a multi-megabyte HTML page. 512 bytes is
      // enough for the provider error code + message; anything beyond that is
      // noise in per-workspace logs and bloats the GCS log archive.
      const axiosDetails: Record<string, unknown> = {};
      if (error && typeof error === "object") {
        if ("config" in error && error.config && typeof error.config === "object") {
          if ("url" in error.config) {
            axiosDetails.url = truncateForLog(error.config.url);
          }
          if ("method" in error.config) {
            axiosDetails.method = error.config.method;
          }
        }
        if ("response" in error && error.response && typeof error.response === "object") {
          const response = error.response;
          if ("status" in response) axiosDetails.status = response.status;
          if ("statusText" in response) {
            axiosDetails.statusText = truncateForLog(response.statusText);
          }
          if ("data" in response) {
            axiosDetails.data = truncateForLog(response.data);
          }
          if ("headers" in response && response.headers && typeof response.headers === "object") {
            if ("www-authenticate" in response.headers) {
              axiosDetails.wwwAuthenticate = response.headers["www-authenticate"];
            }
          }
        }
      }
      logger.error("thread_post_failed", {
        adapterName,
        threadId: chatId,
        error:
          error instanceof Error
            ? { name: error.name, message: error.message, stack }
            : String(error),
        ...(Object.keys(axiosDetails).length > 0 ? { axios: axiosDetails } : {}),
      });
      throw error;
    } finally {
      // Identity-checked finish: if a follow-up turn has already replaced our
      // buffer, that turn owns its own cleanup — don't rip its subscribers
      // out from under it. When `ownBuffer` is undefined (non-web adapter
      // with no buffer at all), this is a no-op, matching prior behavior.
      if (ownBuffer) {
        streamRegistry.finishStreamIfCurrent(chatId, ownBuffer);
      }
    }
  };
}

// Kept async for caller-signature stability — the daemon already awaits this
// and other teammates may too; reverting to sync risks missing a call site.
// deno-lint-ignore require-await
export async function initializeChatSdkInstance(
  config: ChatSdkInstanceConfig,
  credentials?: PlatformCredentials | PlatformCredentials[],
): Promise<ChatSdkInstance> {
  const {
    workspaceId,
    userId,
    signals,
    communicators,
    streamRegistry,
    chatTurnRegistry,
    triggerFn,
  } = config;

  const adapters = buildChatSdkAdapters({
    workspaceId,
    signals,
    communicators,
    credentials,
    streamRegistry,
    chatTurnRegistry,
  });

  const stateAdapter = new ChatSdkStateAdapter({ userId, workspaceId });

  const chat = new Chat({
    userName: "Friday",
    adapters,
    state: stateAdapter,
    concurrency: "concurrent",
    dedupeTtlMs: 600_000,
    logger: "silent",
  });

  const notifier = new ChatSdkNotifier(adapters);
  const broadcastDestinations = collectBroadcastDestinations(signals, communicators);

  const handler = createMessageHandler(workspaceId, triggerFn, streamRegistry, stateAdapter, {
    exposeKernel: config.exposeKernel,
  });
  chat.onNewMention(handler);
  chat.onSubscribedMessage(handler);

  logger.info("chat_sdk_instance_created", {
    workspaceId,
    adapters: Object.keys(adapters),
    broadcastDestinations: Object.keys(broadcastDestinations),
  });

  return {
    chat,
    notifier,
    broadcastDestinations,
    teardown: async () => {
      try {
        await chat.shutdown();
      } catch (error) {
        logger.error("chat_sdk_instance_teardown_failed", { workspaceId, error });
      }
      logger.info("chat_sdk_instance_torn_down", { workspaceId });
    },
  };
}
