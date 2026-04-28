/**
 * Integration tests for `createFSMBroadcastNotifier` — the bridge that lets an
 * FSM `notification` action fan a message out across configured chat
 * communicators. Uses a real `ChatSdkNotifier` with mock chat adapters so the
 * notifier-side filtering, openDM resolution, and per-platform error isolation
 * actually run.
 */

import { describe, expect, it, vi } from "vitest";
import { makeMockAdapter } from "./__test-utils__/mock-adapter.ts";
import type { ChatSdkInstance } from "./chat-sdk-instance.ts";
import { ChatSdkNotifier } from "./chat-sdk-notifier.ts";
import { createFSMBroadcastNotifier } from "./fsm-broadcast-adapter.ts";

const WORKSPACE_ID = "ws-fsm-broadcast";

function buildInstance(adapters: Record<string, ReturnType<typeof makeMockAdapter>>) {
  const notifier = new ChatSdkNotifier(adapters);
  return {
    chat: {} as ChatSdkInstance["chat"],
    notifier,
    broadcastDestinations: {} as Record<string, string>,
    teardown: async () => {},
  };
}

describe("createFSMBroadcastNotifier", () => {
  it("broadcasts to every configured destination when communicators is omitted", async () => {
    const slack = makeMockAdapter("slack");
    const discord = makeMockAdapter("discord");
    const instance = buildInstance({ slack, discord });
    instance.broadcastDestinations = { slack: "C123", discord: "user:user-7" };

    const adapter = createFSMBroadcastNotifier({
      workspaceId: WORKSPACE_ID,
      getInstance: () => Promise.resolve(instance),
    });
    await adapter.broadcast({ message: "hello" });

    expect(slack.postMessage).toHaveBeenCalledWith("slack:C123:", { markdown: "hello" });
    // openDM resolves user:user-7 → discord threadId, then post.
    expect(discord.openDM).toHaveBeenCalledWith("user-7");
    expect(discord.postMessage).toHaveBeenCalledWith("discord:@me:dm-discord", {
      markdown: "hello",
    });
  });

  it("filters destinations down to the communicators allowlist", async () => {
    const slack = makeMockAdapter("slack");
    const discord = makeMockAdapter("discord");
    const instance = buildInstance({ slack, discord });
    instance.broadcastDestinations = { slack: "C123", discord: "user:user-7" };

    const adapter = createFSMBroadcastNotifier({
      workspaceId: WORKSPACE_ID,
      getInstance: () => Promise.resolve(instance),
    });
    await adapter.broadcast({ message: "hi", communicators: ["slack"] });

    expect(slack.postMessage).toHaveBeenCalledTimes(1);
    expect(discord.postMessage).not.toHaveBeenCalled();
  });

  it("throws when an allowlisted communicator has no configured destination (catches typos)", async () => {
    const slack = makeMockAdapter("slack");
    const instance = buildInstance({ slack });
    instance.broadcastDestinations = { slack: "C123" };

    const adapter = createFSMBroadcastNotifier({
      workspaceId: WORKSPACE_ID,
      getInstance: () => Promise.resolve(instance),
    });

    // "slak" is a typo of "slack" — strict mode rejects rather than silently
    // posting only to slack.
    await expect(
      adapter.broadcast({ message: "hi", communicators: ["slack", "slak"] }),
    ).rejects.toThrow(/\[slak\] have no default_destination/);
    expect(slack.postMessage).not.toHaveBeenCalled();
  });

  it("throws with a workspace-config diagnostic when no communicators are configured at all", async () => {
    const instance = buildInstance({});
    instance.broadcastDestinations = {};

    const adapter = createFSMBroadcastNotifier({
      workspaceId: WORKSPACE_ID,
      getInstance: () => Promise.resolve(instance),
    });

    await expect(adapter.broadcast({ message: "hi" })).rejects.toThrow(
      /Workspace has no chat communicators with a default_destination/,
    );
  });

  it("propagates getInstance failures so the FSM step fails loud", async () => {
    const adapter = createFSMBroadcastNotifier({
      workspaceId: WORKSPACE_ID,
      getInstance: vi
        .fn<(id: string) => Promise<ChatSdkInstance>>()
        .mockRejectedValue(new Error("chat-sdk init failed")),
    });

    await expect(adapter.broadcast({ message: "hi" })).rejects.toThrow(/chat-sdk init failed/);
  });

  it("isolates per-platform delivery errors via broadcastJobOutput (slack throws, discord still posts)", async () => {
    const slack = makeMockAdapter("slack", { postError: new Error("slack 429") });
    const discord = makeMockAdapter("discord");
    const instance = buildInstance({ slack, discord });
    instance.broadcastDestinations = { slack: "C123", discord: "user:user-7" };

    const adapter = createFSMBroadcastNotifier({
      workspaceId: WORKSPACE_ID,
      getInstance: () => Promise.resolve(instance),
    });

    // Per-platform errors are swallowed by broadcastJobOutput — the adapter
    // only throws on configuration errors. This guards against accidental
    // fail-fast behavior creeping in.
    await expect(adapter.broadcast({ message: "hi" })).resolves.toBeUndefined();
    expect(discord.postMessage).toHaveBeenCalledTimes(1);
  });
});
