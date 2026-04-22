/**
 * Per-workspace Chat SDK instance lifecycle. Wires the adapter factory,
 * ChatSdkStateAdapter, signalToStream bridge, and the shared message handler
 * that fires the "chat" signal.
 */
import process from "node:process";
import type { AtlasUIMessage } from "@atlas/agent-sdk";
import { ChatSdkStateAdapter } from "@atlas/core/chat/chat-sdk-state-adapter";
import { ChatStorage } from "@atlas/core/chat/storage";
import { fetchLinkCredential } from "@atlas/core/mcp-registry/credential-resolver";
import { createLogger, type Logger } from "@atlas/logger";
import { signalToStream, type TriggerFn } from "@atlas/workspace/signal-to-stream";
import { DiscordAdapter } from "@chat-adapter/discord";
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
import { buildChatSdkAdapters, type PlatformCredentials } from "./adapter-factory.ts";

const logger = createLogger({ component: "chat-sdk-instance" });

export interface ChatSdkInstanceConfig {
  workspaceId: string;
  userId: string;
  signals?: Record<string, { provider?: string; config?: Record<string, unknown> }>;
  streamRegistry: StreamRegistry;
  triggerFn: TriggerFn;
  exposeKernel?: boolean;
  /**
   * Called from teardown's finally block to drop any idle-reaper pin the
   * daemon set when the instance was built. Optional so test fixtures and
   * non-daemon callers don't have to wire it.
   */
  releasePreventIdle?: (workspaceId: string) => void;
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
  signals?: Record<string, { provider?: string; config?: Record<string, unknown> }>,
): Promise<ResolvedCredentials[]> {
  const resolved: ResolvedCredentials[] = [];

  if (signals) {
    const telegramCreds = resolveTelegramCredentials(signals);
    if (telegramCreds) resolved.push(telegramCreds);

    const whatsappCreds = resolveWhatsappCredentials(signals);
    if (whatsappCreds) resolved.push(whatsappCreds);

    const discordCreds = resolveDiscordCredentials(signals);
    if (discordCreds) resolved.push(discordCreds);

    const slackSignalCreds = resolveSlackFromSignals(signals);
    if (slackSignalCreds) {
      resolved.push(slackSignalCreds);
      return resolved;
    }
  }

  const slackLinkCreds = await resolveSlackFromLink(workspaceId);
  if (slackLinkCreds) resolved.push(slackLinkCreds);

  return resolved;
}

function resolveTelegramCredentials(
  signals: Record<string, { provider?: string; config?: Record<string, unknown> }>,
): ResolvedCredentials | null {
  for (const signal of Object.values(signals)) {
    if (signal.provider !== "telegram") continue;

    const botToken =
      (typeof signal.config?.bot_token === "string" ? signal.config.bot_token : null) ??
      process.env.TELEGRAM_BOT_TOKEN;

    if (!botToken) {
      logger.debug("telegram_no_bot_token", {
        hint: "Set bot_token in signal config or TELEGRAM_BOT_TOKEN env var",
      });
      return null;
    }

    const webhookSecret =
      (typeof signal.config?.webhook_secret === "string" ? signal.config.webhook_secret : null) ??
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
  signals: Record<string, { provider?: string; config?: Record<string, unknown> }>,
): ResolvedCredentials | null {
  for (const signal of Object.values(signals)) {
    if (signal.provider !== "whatsapp") continue;

    const cfg = signal.config ?? {};
    const accessToken =
      (typeof cfg.access_token === "string" ? cfg.access_token : null) ??
      process.env.WHATSAPP_ACCESS_TOKEN;
    const appSecret =
      (typeof cfg.app_secret === "string" ? cfg.app_secret : null) ??
      process.env.WHATSAPP_APP_SECRET;
    const phoneNumberId =
      (typeof cfg.phone_number_id === "string" ? cfg.phone_number_id : null) ??
      process.env.WHATSAPP_PHONE_NUMBER_ID;
    const verifyToken =
      (typeof cfg.verify_token === "string" ? cfg.verify_token : null) ??
      process.env.WHATSAPP_VERIFY_TOKEN;

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
  return null;
}

function resolveDiscordCredentials(
  signals: Record<string, { provider?: string; config?: Record<string, unknown> }>,
): ResolvedCredentials | null {
  for (const signal of Object.values(signals)) {
    if (signal.provider !== "discord") continue;

    const botToken = process.env.DISCORD_BOT_TOKEN;
    const publicKey = process.env.DISCORD_PUBLIC_KEY;
    const applicationId = process.env.DISCORD_APPLICATION_ID;

    if (!botToken || !publicKey || !applicationId) {
      const missing: string[] = [];
      if (!botToken) missing.push("DISCORD_BOT_TOKEN");
      if (!publicKey) missing.push("DISCORD_PUBLIC_KEY");
      if (!applicationId) missing.push("DISCORD_APPLICATION_ID");
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

function resolveSlackFromSignals(
  signals: Record<string, { provider?: string; config?: Record<string, unknown> }>,
): ResolvedCredentials | null {
  for (const signal of Object.values(signals)) {
    if (signal.provider !== "slack") continue;

    const botToken =
      (typeof signal.config?.bot_token === "string" ? signal.config.bot_token : null) ??
      process.env.SLACK_BOT_TOKEN;
    if (!botToken) {
      logger.debug("slack_signal_no_bot_token", {
        hint: "Set bot_token in signal config or SLACK_BOT_TOKEN env var",
      });
      return null;
    }

    const signingSecret =
      (typeof signal.config?.signing_secret === "string" ? signal.config.signing_secret : null) ??
      process.env.SLACK_SIGNING_SECRET;
    if (!signingSecret) {
      logger.debug("slack_signal_no_signing_secret", {
        hint: "Set signing_secret in signal config or SLACK_SIGNING_SECRET env var",
      });
      return null;
    }

    const appId =
      (typeof signal.config?.app_id === "string" ? signal.config.app_id : null) ??
      process.env.SLACK_APP_ID ??
      "";

    return {
      credentials: { kind: "slack", botToken, signingSecret, appId },
      credentialId: appId ? `slack:${appId}` : `slack:${botToken.slice(-8)}`,
    };
  }
  return null;
}

async function resolveSlackFromLink(workspaceId: string): Promise<ResolvedCredentials | null> {
  const linkServiceUrl = process.env.LINK_SERVICE_URL ?? "http://localhost:3100";
  const url = `${linkServiceUrl}/internal/v1/slack-apps/by-workspace/${encodeURIComponent(workspaceId)}`;

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

  const { credential_id, app_id } = ByWorkspaceResponseSchema.parse(await res.json());

  const credential = await fetchLinkCredential(credential_id, logger);
  const secret = SlackCredentialSecretSchema.parse(credential.secret);

  if (secret.access_token === "pending") {
    logger.debug("chat_sdk_credential_pending", { workspaceId, credentialId: credential_id });
    return null;
  }

  if (!secret.signing_secret) {
    logger.warn("chat_sdk_missing_signing_secret", { workspaceId, credentialId: credential_id });
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
        adapterName === "whatsapp");
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
      const stack =
        error instanceof Error && error.stack
          ? error.stack.split("\n").slice(0, 8).join("\n")
          : undefined;
      logger.error("thread_post_failed", {
        adapterName,
        threadId: chatId,
        error:
          error instanceof Error
            ? { name: error.name, message: error.message, stack }
            : String(error),
      });
      throw error;
    } finally {
      streamRegistry.finishStream(chatId);
    }
  };
}

const DISCORD_GATEWAY_DURATION_MS = 12 * 60 * 60 * 1000;
const DISCORD_GATEWAY_RETRY_DELAY_MS = 30_000;

/**
 * Authentication failures — stop the supervisor hard. Retrying with a bad
 * bot token risks Discord rate-limiting or banning the token. Checks three
 * shapes that discord.js / @discordjs/rest can surface:
 *   - `DiscordAPIError` with `.code === "TokenInvalid"` or `.status === 401`
 *   - Gateway WebSocket close code 4004 (`.code === 4004`) for auth failure
 *   - Plain `Error("An invalid token was provided.")` from `client.login`
 */
function isDiscordAuthError(err: unknown): boolean {
  if (err instanceof Error) {
    const code = "code" in err ? err.code : undefined;
    const status = "status" in err ? err.status : undefined;
    if (code === "TokenInvalid" || code === 4004 || status === 401) {
      return true;
    }
    return /invalid token|unauthor|\b401\b/i.test(err.message);
  }
  return /invalid token|unauthor|\b401\b/i.test(String(err));
}

/** Resolves early if the signal aborts, otherwise after `ms` ticks. */
function cancellableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timeout);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Supervise a DiscordAdapter's Gateway WebSocket listener for the lifetime
 * of a ChatSdkInstance. The underlying adapter's `startGatewayListener`
 * returns a Response almost immediately and hands the long-running work to
 * `options.waitUntil`; we capture that inner promise and await it as the
 * real loop boundary. On clean exit (duration elapsed) we respawn
 * immediately. On thrown error we wait 30s then respawn — discord.js
 * handles transient reconnects internally, so no exponential backoff is
 * needed. Auth errors stop the supervisor permanently to avoid token bans.
 */
export function superviseDiscordGateway(
  adapter: DiscordAdapter,
  log: Logger,
): { stop: () => Promise<void> } {
  const controller = new AbortController();
  let currentListenerPromise: Promise<unknown> | undefined;

  const loop = async (): Promise<void> => {
    while (!controller.signal.aborted) {
      let listenerPromise: Promise<unknown> | undefined;
      try {
        await adapter.startGatewayListener(
          {
            waitUntil: (task: Promise<unknown>) => {
              listenerPromise = task;
              currentListenerPromise = task;
            },
          },
          DISCORD_GATEWAY_DURATION_MS,
          controller.signal,
        );
        if (listenerPromise) {
          await listenerPromise;
        }
      } catch (error) {
        if (isDiscordAuthError(error)) {
          log.error("discord_gateway_auth_failed", { error });
          break;
        }
        log.warn("discord_gateway_listener_error", { error });
        await cancellableSleep(DISCORD_GATEWAY_RETRY_DELAY_MS, controller.signal);
      }
    }
  };

  const loopPromise = loop();
  loopPromise.catch((error) => {
    log.error("discord_gateway_supervisor_crashed", { error });
  });

  return {
    stop: async () => {
      controller.abort();
      // Wait for the in-flight listener AND the loop itself to settle so no
      // orphan WebSocket outlives teardown. Swallow rejections — they were
      // already logged inside the loop.
      await Promise.allSettled([currentListenerPromise, loopPromise]);
    },
  };
}

export async function initializeChatSdkInstance(
  config: ChatSdkInstanceConfig,
  credentials?: PlatformCredentials | PlatformCredentials[],
): Promise<ChatSdkInstance> {
  const { workspaceId, userId, signals, streamRegistry, triggerFn } = config;

  const adapters = buildChatSdkAdapters({ workspaceId, signals, credentials, streamRegistry });

  const stateAdapter = new ChatSdkStateAdapter({ userId, workspaceId });

  const chat = new Chat({
    userName: "Friday",
    adapters,
    state: stateAdapter,
    concurrency: "concurrent",
    dedupeTtlMs: 600_000,
    logger: "silent",
  });

  const handler = createMessageHandler(workspaceId, triggerFn, streamRegistry, stateAdapter, {
    exposeKernel: config.exposeKernel,
  });
  chat.onNewMention(handler);
  chat.onSubscribedMessage(handler);

  // Discord Gateway is inbound-only, so chat.ensureInitialized never fires
  // lazily (it's driven by outbound webhook handling). Explicitly initialize
  // here to wire `adapter.chat` before the supervisor's first
  // `startGatewayListener` call — otherwise the listener returns 500.
  const discordAdapter = adapters.discord;
  let discordSupervisor: { stop: () => Promise<void> } | null = null;
  if (discordAdapter instanceof DiscordAdapter) {
    await chat.initialize();
    discordSupervisor = superviseDiscordGateway(discordAdapter, logger);
  }

  logger.info("chat_sdk_instance_created", {
    workspaceId,
    adapters: Object.keys(adapters),
    discordGateway: discordSupervisor !== null,
  });

  return {
    chat,
    teardown: async () => {
      // Stop the Gateway supervisor BEFORE chat.shutdown() so the listener
      // exits cleanly while the adapter's internal `chat` reference is still
      // valid. chat.shutdown() then fans out adapter.disconnect() to every
      // adapter (including SlackAdapter's WebClient keep-alive pool and
      // lookup caches) and finishes by calling stateAdapter.disconnect().
      //
      // The outer try/finally guarantees the idle-reaper pin is released even
      // if supervisor.stop() or chat.shutdown() throw past their inner
      // catches — a zombie pin would permanently exempt the workspace from
      // reaping.
      try {
        if (discordSupervisor) {
          try {
            await discordSupervisor.stop();
          } catch (error) {
            logger.error("discord_gateway_supervisor_stop_failed", { workspaceId, error });
          }
        }
        try {
          await chat.shutdown();
        } catch (error) {
          logger.error("chat_sdk_instance_teardown_failed", { workspaceId, error });
        }
        logger.info("chat_sdk_instance_torn_down", { workspaceId });
      } finally {
        config.releasePreventIdle?.(workspaceId);
      }
    },
  };
}
