/**
 * Builds the Chat SDK adapter map for a workspace. Every workspace gets the
 * AtlasWebAdapter; workspaces with a chat-capable platform signal (Slack)
 * and matching credentials additionally get that platform's adapter.
 */

import { createLogger } from "@atlas/logger";
import { SlackAdapter } from "@chat-adapter/slack";
import type { Adapter } from "chat";
import type { StreamRegistry } from "../stream-registry.ts";
import { AtlasWebAdapter } from "./atlas-web-adapter.ts";

const logger = createLogger({ component: "chat-sdk-adapter-factory" });

export interface PlatformCredentials {
  botToken: string;
  signingSecret: string;
  appId: string;
}

export interface ChatSdkAdapterConfig {
  workspaceId: string;
  signals?: Record<string, { provider?: string; config?: Record<string, unknown> }>;
  credentials?: PlatformCredentials;
  streamRegistry: StreamRegistry;
}

const platformAdapterFactories: Record<string, (creds: PlatformCredentials) => Adapter> = {
  slack: (creds) =>
    new SlackAdapter({ botToken: creds.botToken, signingSecret: creds.signingSecret }),
} as const;

export function buildChatSdkAdapters(config: ChatSdkAdapterConfig): Record<string, Adapter> {
  const adapters: Record<string, Adapter> = {
    atlas: new AtlasWebAdapter({
      streamRegistry: config.streamRegistry,
      workspaceId: config.workspaceId,
    }),
  };

  const provider = findChatProvider(config.signals);
  if (!provider) return adapters;

  const factory = platformAdapterFactories[provider];
  if (!factory) return adapters;

  if (!config.credentials) {
    logger.warn("platform_adapter_skipped_no_credentials", {
      workspaceId: config.workspaceId,
      provider,
    });
    return adapters;
  }

  adapters[provider] = factory(config.credentials);
  return adapters;
}

function findChatProvider(
  signals?: Record<string, { provider?: string; config?: Record<string, unknown> }>,
): string | null {
  if (!signals) return null;

  for (const signal of Object.values(signals)) {
    const provider = signal?.provider;
    if (provider && provider in platformAdapterFactories) {
      return provider;
    }
  }
  return null;
}
