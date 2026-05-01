/**
 * Outbound chat notifier. Wraps the per-workspace adapter registry produced by
 * `buildChatSdkAdapters` and exposes a transactional `post()` plus discoverability
 * helper `list()`. Filters out stub adapters (those marked
 * `outboundDeliverable: false`) so callers receive a typed error rather than
 * silent success when they target a non-deliverable communicator.
 *
 * Does NOT write chat storage, subscribe threads, or stream — that's the
 * existing chat path's responsibility (`thread.post(stream)` on the inbound
 * adapter).
 */

import type { Adapter, RawMessage, Root } from "chat";
import { CHAT_PROVIDERS, type ChatProvider } from "./adapter-factory.ts";

/**
 * Subset of `AdapterPostableMessage` the notifier accepts. AtlasUIMessage is
 * deliberately excluded — its lossy projection onto chat platforms depends on
 * the source agent's intent, which the notifier doesn't have.
 */
export type NotifierPostable = string | { markdown: string } | { ast: Root };

export interface NotifierPostResult {
  messageId: string;
  threadId: string;
  raw: unknown;
}

export interface NotifierEntry {
  name: string;
  kind: ChatProvider;
}

export class UnknownCommunicatorError extends Error {
  readonly attempted: string;
  readonly available: ReadonlyArray<NotifierEntry>;

  constructor(attempted: string, available: ReadonlyArray<NotifierEntry>) {
    const list = available.map((entry) => `${entry.name} (${entry.kind})`).join(", ") || "<none>";
    super(`Unknown communicator "${attempted}". Available: ${list}`);
    this.name = "UnknownCommunicatorError";
    this.attempted = attempted;
    this.available = available;
  }
}

function isOutboundDeliverable(adapter: Adapter): boolean {
  return !(
    "outboundDeliverable" in adapter &&
    (adapter as { outboundDeliverable?: boolean }).outboundDeliverable === false
  );
}

function isChatProvider(value: string): value is ChatProvider {
  return (CHAT_PROVIDERS as readonly string[]).includes(value);
}

export class ChatSdkNotifier {
  private readonly adapters: Map<string, { adapter: Adapter; kind: ChatProvider }>;

  constructor(adapters: Record<string, Adapter>) {
    this.adapters = new Map();
    for (const [key, adapter] of Object.entries(adapters)) {
      if (!isOutboundDeliverable(adapter)) continue;
      if (!isChatProvider(key)) continue;
      this.adapters.set(key, { adapter, kind: key });
    }
  }

  list(): Array<NotifierEntry> {
    return Array.from(this.adapters.entries()).map(([name, { kind }]) => ({ name, kind }));
  }

  async post(args: {
    communicator: string;
    destination: string;
    message: NotifierPostable;
  }): Promise<NotifierPostResult> {
    const entry = this.adapters.get(args.communicator);
    if (!entry) {
      throw new UnknownCommunicatorError(args.communicator, this.list());
    }
    const raw: RawMessage = await entry.adapter.postMessage(args.destination, args.message);
    return { messageId: raw.id, threadId: raw.threadId, raw: raw.raw };
  }

  /**
   * Resolve a user ID into a DM threadId for the given communicator. The
   * returned string is shaped per the platform's threadId convention
   * (e.g. `discord:@me:<dm-channel>`) and can be passed straight to `post()`.
   * Throws `UnknownCommunicatorError` when the communicator isn't registered,
   * or `Error` when the registered adapter doesn't implement `openDM`
   * (the chat-SDK declares it optional — `Adapter.openDM?`).
   */
  async openDM(communicator: string, userId: string): Promise<string> {
    const entry = this.adapters.get(communicator);
    if (!entry) {
      throw new UnknownCommunicatorError(communicator, this.list());
    }
    if (typeof entry.adapter.openDM !== "function") {
      throw new Error(
        `Adapter "${communicator}" (kind=${entry.kind}) does not implement openDM — cannot resolve DM threadId for user "${userId}".`,
      );
    }
    return await entry.adapter.openDM(userId);
  }
}
