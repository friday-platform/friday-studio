/**
 * Builds the Chat SDK adapter map for a workspace. Every workspace gets the
 * AtlasWebAdapter; workspaces with a chat-capable platform signal (Slack,
 * Telegram, WhatsApp, etc.) and matching credentials additionally get that
 * platform's adapter.
 */

import { createLogger } from "@atlas/logger";
import { createDiscordAdapter } from "@chat-adapter/discord";
import { SlackAdapter } from "@chat-adapter/slack";
import { createTelegramAdapter } from "@chat-adapter/telegram";
import { createWhatsAppAdapter } from "@chat-adapter/whatsapp";
import type { Adapter } from "chat";
import type { StreamRegistry } from "../stream-registry.ts";
import { AtlasWebAdapter } from "./atlas-web-adapter.ts";
import { toDiscordLogger } from "./discord-logger.ts";

const logger = createLogger({ component: "chat-sdk-adapter-factory" });

export type PlatformCredentials =
  | { kind: "slack"; botToken: string; signingSecret: string; appId: string }
  | { kind: "telegram"; botToken: string; secretToken: string; appId: string }
  | {
      kind: "whatsapp";
      accessToken: string;
      appSecret: string;
      phoneNumberId: string;
      verifyToken: string;
    }
  | { kind: "discord"; botToken: string; publicKey: string; applicationId: string };

/** Supported chat-capable platform providers. */
export const CHAT_PROVIDERS = ["slack", "telegram", "whatsapp", "discord"] as const;
export type ChatProvider = (typeof CHAT_PROVIDERS)[number];

export interface ChatSdkAdapterConfig {
  workspaceId: string;
  signals?: Record<string, { provider?: string; config?: Record<string, unknown> }>;
  credentials?: PlatformCredentials | PlatformCredentials[];
  streamRegistry: StreamRegistry;
}

function buildAdapter(creds: PlatformCredentials): Adapter {
  switch (creds.kind) {
    case "slack":
      return new SlackAdapter({ botToken: creds.botToken, signingSecret: creds.signingSecret });
    case "telegram":
      return createTelegramAdapter({ botToken: creds.botToken, secretToken: creds.secretToken });
    case "whatsapp":
      return createWhatsAppAdapter({
        accessToken: creds.accessToken,
        appSecret: creds.appSecret,
        phoneNumberId: creds.phoneNumberId,
        verifyToken: creds.verifyToken,
      });
    case "discord":
      return createDiscordAdapter({
        botToken: creds.botToken,
        publicKey: creds.publicKey,
        applicationId: creds.applicationId,
        logger: toDiscordLogger(logger.child({ component: "discord" })),
      });
  }
}

export function buildChatSdkAdapters(config: ChatSdkAdapterConfig): Record<string, Adapter> {
  const adapters: Record<string, Adapter> = {
    atlas: new AtlasWebAdapter({
      streamRegistry: config.streamRegistry,
      workspaceId: config.workspaceId,
    }),
  };

  const providers = findChatProviders(config.signals);
  if (providers.length === 0) return adapters;

  const credsList = config.credentials
    ? Array.isArray(config.credentials)
      ? config.credentials
      : [config.credentials]
    : [];

  if (credsList.length === 0) {
    logger.warn("platform_adapter_skipped_no_credentials", {
      workspaceId: config.workspaceId,
      providers,
    });
    return adapters;
  }

  // Key each adapter by its credential kind so the Chat SDK can route inbound
  // webhooks to the right handler (chat.webhooks.telegram, .whatsapp, .slack).
  // Duplicate kinds are last-wins; surface them explicitly so an operator who
  // wires two WhatsApp numbers into one workspace sees why only one responds.
  const seenKinds = new Set<string>();
  for (const creds of credsList) {
    if (seenKinds.has(creds.kind)) {
      logger.warn("platform_adapter_duplicate_kind_overwritten", {
        workspaceId: config.workspaceId,
        kind: creds.kind,
      });
    }
    seenKinds.add(creds.kind);
    adapters[creds.kind] = buildAdapter(creds);
  }
  return adapters;
}

function isChatProvider(value: string): value is ChatProvider {
  return (CHAT_PROVIDERS as readonly string[]).includes(value);
}

function findChatProviders(
  signals?: Record<string, { provider?: string; config?: Record<string, unknown> }>,
): ChatProvider[] {
  if (!signals) return [];
  const seen = new Set<ChatProvider>();
  for (const signal of Object.values(signals)) {
    const provider = signal?.provider;
    if (provider && isChatProvider(provider)) {
      seen.add(provider);
    }
  }
  return [...seen];
}
