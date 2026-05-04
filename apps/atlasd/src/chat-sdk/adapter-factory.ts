/**
 * Builds the Chat SDK adapter map for a workspace. Every workspace gets the
 * AtlasWebAdapter; workspaces with a chat-capable platform signal (Slack,
 * Telegram, WhatsApp, etc.) and matching credentials additionally get that
 * platform's adapter.
 */

import { createLogger } from "@atlas/logger";
import { createDiscordAdapter } from "@chat-adapter/discord";
import { SlackAdapter } from "@chat-adapter/slack";
import { createTeamsAdapter } from "@chat-adapter/teams";
import { createTelegramAdapter } from "@chat-adapter/telegram";
import { createWhatsAppAdapter } from "@chat-adapter/whatsapp";
import type { Adapter } from "chat";
import type { ChatTurnRegistry } from "../chat-turn-registry.ts";
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
  | { kind: "discord"; botToken: string; publicKey: string; applicationId: string }
  | {
      kind: "teams";
      appId: string;
      appPassword: string;
      appTenantId?: string;
      appType?: "MultiTenant" | "SingleTenant";
    };

/** Supported chat-capable platform providers. */
export const CHAT_PROVIDERS = ["slack", "telegram", "whatsapp", "discord", "teams"] as const;
export type ChatProvider = (typeof CHAT_PROVIDERS)[number];

/**
 * Top-level workspace.yml `communicators` declaration. Same shape as
 * `CommunicatorConfig` from `@atlas/config` (kept structural here to avoid a
 * circular runtime dep) — the discriminator is `kind`, all platform fields
 * are optional and fall through to env vars / Link at resolve time.
 */
export type CommunicatorEntry = { kind?: string } & Record<string, unknown>;

export interface ChatSdkAdapterConfig {
  workspaceId: string;
  signals?: Record<string, { provider?: string; config?: Record<string, unknown> }>;
  communicators?: Record<string, CommunicatorEntry>;
  credentials?: PlatformCredentials | PlatformCredentials[];
  streamRegistry: StreamRegistry;
  chatTurnRegistry?: ChatTurnRegistry;
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
    case "teams":
      return createTeamsAdapter({
        appId: creds.appId,
        appPassword: creds.appPassword,
        appTenantId: creds.appTenantId,
        appType: creds.appType,
      });
  }
}

export function buildChatSdkAdapters(config: ChatSdkAdapterConfig): Record<string, Adapter> {
  const adapters: Record<string, Adapter> = {
    atlas: new AtlasWebAdapter({
      streamRegistry: config.streamRegistry,
      chatTurnRegistry: config.chatTurnRegistry,
      workspaceId: config.workspaceId,
    }),
  };

  const providers = findChatProviders(config.signals, config.communicators, config.workspaceId);
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

/**
 * Walk both the new top-level `communicators` map and the existing per-signal
 * `provider` field, deduplicating by chat-adapter kind. Top-level
 * `communicators` declarations always win for adapter discovery; when a kind
 * is also declared under signals we emit a warn so operators can clean up the
 * dead config.
 */
function findChatProviders(
  signals: Record<string, { provider?: string; config?: Record<string, unknown> }> | undefined,
  communicators: Record<string, CommunicatorEntry> | undefined,
  workspaceId: string,
): ChatProvider[] {
  const fromCommunicators = new Set<ChatProvider>();
  if (communicators) {
    for (const entry of Object.values(communicators)) {
      const kind = entry?.kind;
      if (typeof kind === "string" && isChatProvider(kind)) {
        fromCommunicators.add(kind);
      }
    }
  }

  const fromSignals = new Set<ChatProvider>();
  if (signals) {
    for (const signal of Object.values(signals)) {
      const provider = signal?.provider;
      if (provider && isChatProvider(provider)) {
        fromSignals.add(provider);
      }
    }
  }

  for (const kind of fromCommunicators) {
    if (fromSignals.has(kind)) {
      logger.warn("platform_adapter_duplicate_declaration", {
        workspaceId,
        kind,
        source: "communicators_wins",
      });
    }
  }

  return [...new Set<ChatProvider>([...fromCommunicators, ...fromSignals])];
}
