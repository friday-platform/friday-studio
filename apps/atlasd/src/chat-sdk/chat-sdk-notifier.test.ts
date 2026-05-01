/**
 * Tests for ChatSdkNotifier — covers post() happy path, unknown communicator,
 * adapter rejection passthrough, stub-adapter filter (including a real
 * AtlasWebAdapter), message-shape forwarding, and the openDM guard for
 * adapters that don't implement the optional method.
 */

import { describe, expect, it } from "vitest";
import type { StreamRegistry } from "../stream-registry.ts";
import { makeMockAdapter } from "./__test-utils__/mock-adapter.ts";
import { AtlasWebAdapter } from "./atlas-web-adapter.ts";
import {
  ChatSdkNotifier,
  type NotifierPostable,
  UnknownCommunicatorError,
} from "./chat-sdk-notifier.ts";

describe("ChatSdkNotifier.list", () => {
  it("returns deliverable adapters with name and kind", () => {
    const notifier = new ChatSdkNotifier({
      slack: makeMockAdapter("slack"),
      telegram: makeMockAdapter("telegram"),
    });
    expect(notifier.list().sort((a, b) => a.name.localeCompare(b.name))).toEqual([
      { name: "slack", kind: "slack" },
      { name: "telegram", kind: "telegram" },
    ]);
  });

  it("excludes adapters with outboundDeliverable: false", () => {
    const notifier = new ChatSdkNotifier({
      slack: makeMockAdapter("slack"),
      atlas: makeMockAdapter("atlas", { outboundDeliverable: false }),
    });
    expect(notifier.list()).toEqual([{ name: "slack", kind: "slack" }]);
  });

  it("excludes adapters whose registry key is not a known ChatProvider", () => {
    // 'atlas' is not in CHAT_PROVIDERS even without the marker; the notifier's
    // declared surface is restricted to chat-capable platforms.
    const notifier = new ChatSdkNotifier({
      atlas: makeMockAdapter("atlas"),
      slack: makeMockAdapter("slack"),
    });
    expect(notifier.list()).toEqual([{ name: "slack", kind: "slack" }]);
  });

  it("filters out a real AtlasWebAdapter instance via the structural marker", () => {
    const atlasWeb = new AtlasWebAdapter({
      streamRegistry: {} as StreamRegistry,
      workspaceId: "ws-test",
    });
    const notifier = new ChatSdkNotifier({ atlas: atlasWeb, slack: makeMockAdapter("slack") });
    expect(notifier.list()).toEqual([{ name: "slack", kind: "slack" }]);
  });
});

describe("ChatSdkNotifier.post", () => {
  it("returns { messageId, threadId, raw } from the adapter response", async () => {
    const slack = makeMockAdapter("slack", {
      postResult: { id: "slack-msg-42", threadId: "slack:C1:T1", raw: { ok: true, ts: "42" } },
    });
    const notifier = new ChatSdkNotifier({ slack });
    const result = await notifier.post({
      communicator: "slack",
      destination: "slack:C1:",
      message: "hello",
    });
    expect(result).toEqual({
      messageId: "slack-msg-42",
      threadId: "slack:C1:T1",
      raw: { ok: true, ts: "42" },
    });
    expect(slack.postMessage).toHaveBeenCalledWith("slack:C1:", "hello");
  });

  it("throws UnknownCommunicatorError naming the missing key and listing available", async () => {
    const notifier = new ChatSdkNotifier({
      slack: makeMockAdapter("slack"),
      telegram: makeMockAdapter("telegram"),
    });
    await expect(
      notifier.post({ communicator: "discord", destination: "d:c:t", message: "hi" }),
    ).rejects.toMatchObject({
      name: "UnknownCommunicatorError",
      attempted: "discord",
      available: expect.arrayContaining([
        { name: "slack", kind: "slack" },
        { name: "telegram", kind: "telegram" },
      ]),
    });
    await expect(
      notifier.post({ communicator: "discord", destination: "d:c:t", message: "hi" }),
    ).rejects.toThrow(/discord/);
    await expect(
      notifier.post({ communicator: "discord", destination: "d:c:t", message: "hi" }),
    ).rejects.toThrow(/slack/);
  });

  it("throws UnknownCommunicatorError when the requested communicator is a stub", async () => {
    const atlasWeb = new AtlasWebAdapter({
      streamRegistry: {} as StreamRegistry,
      workspaceId: "ws-test",
    });
    const notifier = new ChatSdkNotifier({ atlas: atlasWeb, slack: makeMockAdapter("slack") });
    await expect(
      notifier.post({ communicator: "atlas", destination: "atlas:c:t", message: "hi" }),
    ).rejects.toBeInstanceOf(UnknownCommunicatorError);
  });

  it("propagates adapter errors unchanged", async () => {
    const original = new Error("Slack rate limit");
    const slack = makeMockAdapter("slack", { postError: original });
    const notifier = new ChatSdkNotifier({ slack });
    await expect(
      notifier.post({ communicator: "slack", destination: "slack:C1:", message: "hi" }),
    ).rejects.toBe(original);
  });

  it.each<{ name: string; message: NotifierPostable }>([
    { name: "string", message: "hello" },
    { name: "{ markdown }", message: { markdown: "**hi**" } },
    {
      name: "{ ast }",
      message: {
        ast: {
          type: "root",
          children: [{ type: "paragraph", children: [{ type: "text", value: "hi" }] }],
        },
      },
    },
  ])("forwards $name message shape to adapter.postMessage", async ({ message }) => {
    const slack = makeMockAdapter("slack");
    const notifier = new ChatSdkNotifier({ slack });
    await notifier.post({ communicator: "slack", destination: "slack:C1:", message });
    expect(slack.postMessage).toHaveBeenCalledWith("slack:C1:", message);
  });
});

describe("ChatSdkNotifier.openDM", () => {
  it("returns the adapter's resolved threadId", async () => {
    const discord = makeMockAdapter("discord", { openDMResult: "discord:@me:dm-7" });
    const notifier = new ChatSdkNotifier({ discord });
    expect(await notifier.openDM("discord", "user-7")).toBe("discord:@me:dm-7");
    expect(discord.openDM).toHaveBeenCalledWith("user-7");
  });

  it("throws UnknownCommunicatorError for unregistered communicators", async () => {
    const notifier = new ChatSdkNotifier({ slack: makeMockAdapter("slack") });
    await expect(notifier.openDM("discord", "user-1")).rejects.toBeInstanceOf(
      UnknownCommunicatorError,
    );
  });

  it("throws a typed Error when the adapter doesn't implement openDM", async () => {
    // Some chat-SDK adapters declare openDM as optional. Calling without a
    // guard would produce "openDM is not a function" mid-broadcast; we want a
    // descriptive error instead so the caller can log + skip.
    const slack = makeMockAdapter("slack", { withOpenDM: false });
    const notifier = new ChatSdkNotifier({ slack });
    await expect(notifier.openDM("slack", "user-1")).rejects.toThrow(/does not implement openDM/);
  });

  it("propagates adapter openDM errors unchanged", async () => {
    const original = new Error("Discord rate limited");
    const discord = makeMockAdapter("discord", { openDMError: original });
    const notifier = new ChatSdkNotifier({ discord });
    await expect(notifier.openDM("discord", "user-1")).rejects.toBe(original);
  });
});
