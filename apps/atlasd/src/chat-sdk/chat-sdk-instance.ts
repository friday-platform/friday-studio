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
import { createLogger } from "@atlas/logger";
import { signalToStream, type TriggerFn } from "@atlas/workspace/signal-to-stream";
import type { Message, StreamEvent, Thread } from "chat";
import { Chat } from "chat";
import { z } from "zod";
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
}

export interface ChatSdkInstance {
  chat: Chat;
  credentialId?: string;
  teardown: () => Promise<void>;
}

export interface ResolvedCredentials {
  credentials: PlatformCredentials;
  credentialId: string;
}

/**
 * Resolve platform credentials for a workspace from the Link service.
 * Returns null when no credentials are wired or the token is pending.
 */
export async function resolvePlatformCredentials(
  workspaceId: string,
): Promise<ResolvedCredentials | null> {
  const linkServiceUrl = process.env.LINK_SERVICE_URL ?? "http://localhost:3100";
  const url = `${linkServiceUrl}/internal/v1/slack-apps/by-workspace/${encodeURIComponent(workspaceId)}`;

  const headers: Record<string, string> = {};
  if (process.env.LINK_DEV_MODE !== "true") {
    const atlasKey = process.env.ATLAS_KEY;
    if (atlasKey) {
      headers.Authorization = `Bearer ${atlasKey}`;
    }
  }

  const res = await fetch(url, { headers });

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
): (thread: Thread, message: Message) => Promise<void> {
  return async (thread: Thread, message: Message): Promise<void> => {
    const adapterName = thread.adapter.name;
    const sourceWasSet = stateAdapter && (adapterName === "slack" || adapterName === "discord");
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

    // signalToStream fans events two ways: the tap pushes ALL client-safe
    // events to StreamRegistry for the full web SSE stream, while the async
    // iterable feeds thread.post() → fromFullStream for platform adapters
    // (Slack), which only get text — fromFullStream drops tool/reasoning/data-*.
    const stream = signalToStream<StreamEvent>(
      triggerFn,
      "chat",
      { chatId, userId, streamId, datetime },
      streamId,
      (chunk: unknown) => {
        if (isClientSafeEvent(chunk)) {
          streamRegistry.appendEvent(chatId, chunk);
        }
      },
    );

    try {
      await thread.post(stream);
    } finally {
      streamRegistry.finishStream(chatId);
    }
  };
}

export function initializeChatSdkInstance(
  config: ChatSdkInstanceConfig,
  credentials?: PlatformCredentials,
): ChatSdkInstance {
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

  const handler = createMessageHandler(workspaceId, triggerFn, streamRegistry, stateAdapter);
  chat.onNewMention(handler);
  chat.onSubscribedMessage(handler);

  logger.info("chat_sdk_instance_created", { workspaceId, adapters: Object.keys(adapters) });

  return {
    chat,
    teardown: async () => {
      // chat.shutdown() fans out adapter.disconnect() to every adapter
      // (including SlackAdapter, which holds a WebClient HTTP keep-alive
      // pool and lookup caches) and finishes by calling
      // stateAdapter.disconnect(). Without this, every connect/disconnect/
      // destroy cycle leaks a SlackAdapter until GC.
      try {
        await chat.shutdown();
      } catch (error) {
        logger.error("chat_sdk_instance_teardown_failed", { workspaceId, error });
      }
      logger.info("chat_sdk_instance_torn_down", { workspaceId });
    },
  };
}
