/**
 * Shared test helper for chat-SDK suites. Builds a minimal `Adapter` test
 * double covering only the surfaces the broadcaster + notifier actually
 * exercise. Not exported from production paths.
 *
 * Why we don't import the upstream `createMockAdapter`: it lives in
 * `chat`'s test-only `mock-adapter.ts` and isn't re-exported from the
 * published package surface. Building locally also lets us add the
 * structural `outboundDeliverable` marker the notifier filter reads.
 */

import type { Adapter, FormattedContent, RawMessage } from "chat";
import { vi } from "vitest";

export interface MockAdapterOptions {
  postResult?: RawMessage;
  postError?: Error;
  /** When `false`, the structural marker is set so notifier.list() filters it out. */
  outboundDeliverable?: boolean;
  /** When `false`, drop the optional openDM method entirely (covers the C1 guard). */
  withOpenDM?: boolean;
  openDMResult?: string;
  openDMError?: Error;
}

export function makeMockAdapter(name: string, options: MockAdapterOptions = {}): Adapter {
  const postMessage = options.postError
    ? vi.fn().mockRejectedValue(options.postError)
    : vi
        .fn()
        .mockResolvedValue(
          options.postResult ?? { id: `${name}-msg-1`, threadId: `${name}:c:t`, raw: {} },
        );

  const adapter: Adapter & { outboundDeliverable?: boolean } = {
    name,
    userName: `${name}-bot`,
    initialize: vi.fn().mockResolvedValue(undefined),
    handleWebhook: vi.fn().mockResolvedValue(new Response("ok")),
    postMessage,
    editMessage: vi.fn().mockResolvedValue({ id: "", threadId: "", raw: {} }),
    deleteMessage: vi.fn().mockResolvedValue(undefined),
    addReaction: vi.fn().mockResolvedValue(undefined),
    removeReaction: vi.fn().mockResolvedValue(undefined),
    startTyping: vi.fn().mockResolvedValue(undefined),
    fetchMessages: vi.fn().mockResolvedValue({ messages: [], nextCursor: undefined }),
    fetchThread: vi.fn().mockResolvedValue({ id: "t1", channelId: "c1", metadata: {} }),
    encodeThreadId: vi.fn(() => `${name}:c:t`),
    decodeThreadId: vi.fn(() => ({ channel: "c", thread: "t" })),
    channelIdFromThreadId: vi.fn((threadId: string) => threadId.split(":").slice(0, 2).join(":")),
    parseMessage: vi.fn(),
    renderFormatted: vi.fn((_c: FormattedContent) => "formatted"),
  };
  if (options.outboundDeliverable === false) {
    adapter.outboundDeliverable = false;
  }
  if (options.withOpenDM !== false) {
    adapter.openDM = options.openDMError
      ? vi.fn().mockRejectedValue(options.openDMError)
      : vi.fn().mockResolvedValue(options.openDMResult ?? `${name}:@me:dm-${name}`);
  }
  return adapter;
}
