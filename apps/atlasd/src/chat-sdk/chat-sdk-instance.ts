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
import {
  signalToStream,
  type TriggerFn,
} from "@atlas/workspace/signal-to-stream";
import type { Message, StreamEvent, Thread } from "chat";
import { Chat } from "chat";
import { z } from "zod";
import { KERNEL_WORKSPACE_ID } from "../factory.ts";
import {
  ByWorkspaceResponseSchema,
  SlackCredentialSecretSchema,
} from "../services/slack-credentials.ts";
import { isClientSafeEvent } from "../stream-event-filter.ts";
import type { StreamRegistry } from "../stream-registry.ts";
import {
  buildChatSdkAdapters,
  type PlatformCredentials,
} from "./adapter-factory.ts";

const logger = createLogger({ component: "chat-sdk-instance" });

export interface ChatSdkInstanceConfig {
  workspaceId: string;
  userId: string;
  signals?: Record<
    string,
    { provider?: string; config?: Record<string, unknown> }
  >;
  streamRegistry: StreamRegistry;
  triggerFn: TriggerFn;
  exposeKernel?: boolean;
}

export interface ChatSdkInstance {
  chat: Chat;
  teardown: () => Promise<void>;
}

export interface ResolvedCredentials {
  credentials: PlatformCredentials;
  credentialId: string;
}

/**
 * Resolve every platform credential a workspace has wired. Each provider is
 * resolved independently from workspace.yml signal config + env vars — so a
 * workspace with any combination of Slack, Telegram, WhatsApp signals gets all
 * three adapters. Signal-based (BYO) credentials are the authoritative source;
 * the Link service is consulted only for Slack and only when no slack signal
 * credentials resolved, as a fallback for managed/OAuth-installed Slack apps.
 */
export async function resolvePlatformCredentials(
  workspaceId: string,
  signals: Record<
    string,
    { provider?: string; config?: Record<string, unknown> }
  >,
): Promise<ResolvedCredentials[]> {
  const resolved: ResolvedCredentials[] = [];

  const telegramCreds = resolveTelegramCredentials(signals);
  if (telegramCreds) resolved.push(telegramCreds);

  const whatsappCreds = resolveWhatsappCredentials(signals);
  if (whatsappCreds) resolved.push(whatsappCreds);

  const discordCreds = resolveDiscordCredentials(signals);
  if (discordCreds) resolved.push(discordCreds);

  const teamsCreds = resolveTeamsCredentials(signals);
  if (teamsCreds) resolved.push(teamsCreds);

  const slackSignalCreds = resolveSlackFromSignals(signals);
  if (slackSignalCreds) {
    resolved.push(slackSignalCreds);
    return resolved;
  }

  // Only consult Link for a Slack credential if the workspace actually
  // declares a slack signal. A workspace with only teams / discord / telegram /
  // whatsapp signals has no business pinging Link — it's a pointless HTTP
  // round-trip, and a Link 5xx here would drop the already-resolved creds
  // from the other providers on the floor.
  //
  // The outer try/catch is defense-in-depth: even when a slack signal is
  // present, a transient Link 5xx should downgrade to a warn, not disable
  // every chat adapter on the workspace.
  const hasSlackSignal = Object.values(signals).some((s) =>
    s?.provider === "slack"
  );
  if (hasSlackSignal) {
    try {
      const slackLinkCreds = await resolveSlackFromLink(workspaceId);
      if (slackLinkCreds) resolved.push(slackLinkCreds);
    } catch (error) {
      logger.warn("chat_sdk_slack_link_fallback_failed", {
        workspaceId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return resolved;
}

function resolveTelegramCredentials(
  signals: Record<
    string,
    { provider?: string; config?: Record<string, unknown> }
  >,
): ResolvedCredentials | null {
  for (const signal of Object.values(signals)) {
    if (signal.provider !== "telegram") continue;

    const parsed = TelegramProviderConfigSchema.safeParse(signal.config ?? {});
    if (!parsed.success) {
      logger.debug("telegram_invalid_config", { error: parsed.error.message });
      continue;
    }

    const botToken = parsed.data.bot_token ?? process.env.TELEGRAM_BOT_TOKEN;
    if (!botToken) {
      logger.debug("telegram_no_bot_token", {
        hint: "Set bot_token in signal config or TELEGRAM_BOT_TOKEN env var",
      });
      return null;
    }

    const webhookSecret = parsed.data.webhook_secret ??
      process.env.TELEGRAM_WEBHOOK_SECRET ??
      "";

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
  return null;
}

function resolveWhatsappCredentials(
  signals: Record<
    string,
    { provider?: string; config?: Record<string, unknown> }
  >,
): ResolvedCredentials | null {
  for (const signal of Object.values(signals)) {
    if (signal.provider !== "whatsapp") continue;

    const parsed = WhatsAppProviderConfigSchema.safeParse(signal.config ?? {});
    if (!parsed.success) {
      logger.debug("whatsapp_invalid_config", { error: parsed.error.message });
      continue;
    }

    const accessToken = parsed.data.access_token ??
      process.env.WHATSAPP_ACCESS_TOKEN;
    const appSecret = parsed.data.app_secret ?? process.env.WHATSAPP_APP_SECRET;
    const phoneNumberId = parsed.data.phone_number_id ??
      process.env.WHATSAPP_PHONE_NUMBER_ID;
    const verifyToken = parsed.data.verify_token ??
      process.env.WHATSAPP_VERIFY_TOKEN;

    if (!accessToken || !appSecret || !phoneNumberId || !verifyToken) {
      const missing: string[] = [];
      if (!accessToken) missing.push("access_token / WHATSAPP_ACCESS_TOKEN");
      if (!appSecret) missing.push("app_secret / WHATSAPP_APP_SECRET");
      if (!phoneNumberId) {
        missing.push("phone_number_id / WHATSAPP_PHONE_NUMBER_ID");
      }
      if (!verifyToken) missing.push("verify_token / WHATSAPP_VERIFY_TOKEN");
      logger.debug("whatsapp_missing_credentials", { missing });
      return null;
    }

    return {
      credentials: {
        kind: "whatsapp",
        accessToken,
        appSecret,
        phoneNumberId,
        verifyToken,
      },
      credentialId: `whatsapp:${phoneNumberId}`,
    };
  }
  return null;
}

/**
 * Resolves the per-workspace Discord credentials. The resulting `DiscordAdapter`
 * (built by `buildChatSdkAdapters`) is used for **inbound forwarded Gateway
 * events** (via `chat.webhooks.discord` on `/signals/discord` POSTs) and
 * **outbound `postMessage`** replies. It does NOT own a Gateway connection —
 * that's the daemon-scoped `DiscordGatewayService`'s job.
 *
 * Credentials are resolved config-first, env-fallback — matching the Telegram
 * / Slack / WhatsApp pattern. A workspace with all three fields set inline in
 * `workspace.yml` needs no `DISCORD_*` env vars; an empty `config: {}` pulls
 * from env; partial config falls back field-by-field.
 */
export function resolveDiscordCredentials(
  signals: Record<string, { provider?: string; config?: Record<string, unknown> }>,
): ResolvedCredentials | null {
  for (const signal of Object.values(signals)) {
    if (signal.provider !== "discord") continue;

    const cfg = signal.config ?? {};
    const botToken =
      (typeof cfg.bot_token === "string" ? cfg.bot_token : null) ??
      process.env.DISCORD_BOT_TOKEN;
    const publicKey =
      (typeof cfg.public_key === "string" ? cfg.public_key : null) ??
      process.env.DISCORD_PUBLIC_KEY;
    const applicationId =
      (typeof cfg.application_id === "string" ? cfg.application_id : null) ??
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
  return null;
}

function resolveTeamsCredentials(
  signals: Record<
    string,
    { provider?: string; config?: Record<string, unknown> }
  >,
): ResolvedCredentials | null {
  for (const signal of Object.values(signals)) {
    if (signal.provider !== "teams") continue;

    const parsed = TeamsProviderConfigSchema.safeParse(signal.config ?? {});
    if (!parsed.success) {
      logger.debug("teams_invalid_config", { error: parsed.error.message });
      continue;
    }

    const appId = parsed.data.app_id ?? process.env.TEAMS_APP_ID;
    const appPassword = parsed.data.app_password ??
      process.env.TEAMS_APP_PASSWORD;
    const appTenantId = parsed.data.app_tenant_id ??
      process.env.TEAMS_APP_TENANT_ID;
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
        missing.push(
          "app_tenant_id / TEAMS_APP_TENANT_ID (required for SingleTenant)",
        );
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
  return null;
}

function resolveSlackFromSignals(
  signals: Record<
    string,
    { provider?: string; config?: Record<string, unknown> }
  >,
): ResolvedCredentials | null {
  for (const signal of Object.values(signals)) {
    if (signal.provider !== "slack") continue;

    const parsed = SlackProviderConfigSchema.safeParse(signal.config ?? {});
    if (!parsed.success) {
      logger.debug("slack_invalid_config", { error: parsed.error.message });
      continue;
    }

    const botToken = parsed.data.bot_token ?? process.env.SLACK_BOT_TOKEN;
    if (!botToken) {
      logger.debug("slack_signal_no_bot_token", {
        hint: "Set bot_token in signal config or SLACK_BOT_TOKEN env var",
      });
      return null;
    }

    const signingSecret = parsed.data.signing_secret ??
      process.env.SLACK_SIGNING_SECRET;
    if (!signingSecret) {
      logger.debug("slack_signal_no_signing_secret", {
        hint:
          "Set signing_secret in signal config or SLACK_SIGNING_SECRET env var",
      });
      return null;
    }

    const appId = parsed.data.app_id ?? process.env.SLACK_APP_ID ?? "";

    return {
      credentials: { kind: "slack", botToken, signingSecret, appId },
      credentialId: appId ? `slack:${appId}` : `slack:${botToken.slice(-8)}`,
    };
  }
  return null;
}

async function resolveSlackFromLink(
  workspaceId: string,
): Promise<ResolvedCredentials | null> {
  const linkServiceUrl = process.env.LINK_SERVICE_URL ??
    "http://localhost:3100";
  const url = `${linkServiceUrl}/internal/v1/slack-apps/by-workspace/${
    encodeURIComponent(workspaceId)
  }`;

  const headers: Record<string, string> = {};
  if (process.env.LINK_DEV_MODE !== "true") {
    const atlasKey = process.env.ATLAS_KEY;
    if (atlasKey) {
      headers.Authorization = `Bearer ${atlasKey}`;
    }
  }

  let res: Response;
  try {
    res = await fetch(url, { headers });
  } catch (error) {
    // Link unreachable (dev without the service running, CI, transient net).
    // Treat identically to 404 — no Slack app wired for this workspace.
    logger.debug("chat_sdk_link_unreachable", {
      workspaceId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }

  if (res.status === 404) {
    logger.debug("chat_sdk_no_credential_for_workspace", { workspaceId });
    return null;
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Failed to resolve slack-app for workspace '${workspaceId}': ${res.status} ${body}`,
    );
  }

  const { credential_id, app_id } = ByWorkspaceResponseSchema.parse(
    await res.json(),
  );

  const credential = await fetchLinkCredential(credential_id, logger);
  const secret = SlackCredentialSecretSchema.parse(credential.secret);

  if (secret.access_token === "pending") {
    logger.debug("chat_sdk_credential_pending", {
      workspaceId,
      credentialId: credential_id,
    });
    return null;
  }

  if (!secret.signing_secret) {
    logger.warn("chat_sdk_missing_signing_secret", {
      workspaceId,
      credentialId: credential_id,
    });
    return null;
  }

  return {
    credentials: {
      kind: "slack",
      botToken: secret.access_token,
      signingSecret: secret.signing_secret,
      appId: app_id,
    },
    credentialId: credential_id,
  };
}

const MAX_LOG_FIELD_BYTES = 512;

function truncateForLog(value: unknown): string {
  const str = typeof value === "string"
    ? value
    : JSON.stringify(value) ?? String(value);
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
    const sourceWasSet = stateAdapter &&
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
      thread.adapter.addReaction(thread.id, message.id, "eyes").catch(
        (err: unknown) => {
          logger.warn("acknowledgment_reaction_failed", {
            threadId: thread.id,
            error: err,
          });
        },
      );
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

    const appendResult = await ChatStorage.appendMessage(
      chatId,
      storedMessage,
      workspaceId,
    );
    if (!appendResult.ok) {
      logger.error("chat_sdk_append_message_failed", {
        chatId,
        workspaceId,
        error: appendResult.error,
      });
    }

    const datetime = typeof message.raw === "object" && message.raw !== null &&
        "datetime" in message.raw
      ? message.raw.datetime
      : undefined;

    const rawFgPayload = typeof message.raw === "object" &&
        message.raw !== null &&
        "foregroundWorkspaceIds" in message.raw
      ? message.raw.foregroundWorkspaceIds
      : undefined;
    const foregroundWorkspaceIds = Array.isArray(rawFgPayload)
      ? rawFgPayload
        .filter((id: unknown): id is string => typeof id === "string")
        .filter((id) => options?.exposeKernel || id !== KERNEL_WORKSPACE_ID)
      : undefined;

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
          const appended = streamRegistry.appendEvent(chatId, chunk);
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
    );

    try {
      await thread.post(stream);
    } catch (error) {
      // Surface adapter-side post failures (e.g. Meta Graph API errors).
      // Without this the stream silently swallows the error and the user
      // sees no reply on their platform. Keep the first handful of stack
      // frames so Sentry can group by call site; the adapter's own error
      // message carries the provider-specific code (e.g. fbtrace_id on
      // Meta, Slack error types) — docs/integrations/<provider>/README.md
      // maps common codes to fixes.
      const stack = error instanceof Error && error.stack
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
        if (
          "config" in error && error.config && typeof error.config === "object"
        ) {
          if ("url" in error.config) {
            axiosDetails.url = truncateForLog(error.config.url);
          }
          if ("method" in error.config) {
            axiosDetails.method = error.config.method;
          }
        }
        if (
          "response" in error && error.response &&
          typeof error.response === "object"
        ) {
          const response = error.response;
          if ("status" in response) axiosDetails.status = response.status;
          if ("statusText" in response) {
            axiosDetails.statusText = truncateForLog(response.statusText);
          }
          if ("data" in response) {
            axiosDetails.data = truncateForLog(response.data);
          }
          if (
            "headers" in response && response.headers &&
            typeof response.headers === "object"
          ) {
            if ("www-authenticate" in response.headers) {
              axiosDetails.wwwAuthenticate =
                response.headers["www-authenticate"];
            }
          }
        }
      }
      logger.error("thread_post_failed", {
        adapterName,
        threadId: chatId,
        error: error instanceof Error
          ? { name: error.name, message: error.message, stack }
          : String(error),
        ...(Object.keys(axiosDetails).length > 0
          ? { axios: axiosDetails }
          : {}),
      });
      throw error;
    } finally {
      streamRegistry.finishStream(chatId);
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
  const { workspaceId, userId, signals, streamRegistry, triggerFn } = config;

  const adapters = buildChatSdkAdapters({
    workspaceId,
    signals,
    credentials,
    streamRegistry,
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

  const handler = createMessageHandler(
    workspaceId,
    triggerFn,
    streamRegistry,
    stateAdapter,
    {
      exposeKernel: config.exposeKernel,
    },
  );
  chat.onNewMention(handler);
  chat.onSubscribedMessage(handler);

  logger.info("chat_sdk_instance_created", {
    workspaceId,
    adapters: Object.keys(adapters),
  });

  return {
    chat,
    teardown: async () => {
      try {
        await chat.shutdown();
      } catch (error) {
        logger.error("chat_sdk_instance_teardown_failed", {
          workspaceId,
          error,
        });
      }
      logger.info("chat_sdk_instance_torn_down", { workspaceId });
    },
  };
}
