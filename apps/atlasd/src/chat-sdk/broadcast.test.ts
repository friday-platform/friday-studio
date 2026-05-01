/**
 * Tests for `broadcastJobOutput` — the helper the daemon's onSessionComplete
 * hook calls to fan a session's final output across configured chat
 * communicators. Covers source-skip, no-destination short-circuit, the
 * `user:<id>` openDM resolution path (including failure isolation),
 * full-threadId pass-through vs raw-channel formatting, and per-platform
 * error isolation.
 */

import { describe, expect, it } from "vitest";
import { makeMockAdapter } from "./__test-utils__/mock-adapter.ts";
import { broadcastJobOutput } from "./broadcast.ts";
import { ChatSdkNotifier } from "./chat-sdk-notifier.ts";

const WORKSPACE_ID = "ws-broadcast-test";

describe("broadcastJobOutput", () => {
  it("posts to every configured target when no source is provided", async () => {
    const slack = makeMockAdapter("slack");
    const discord = makeMockAdapter("discord");
    const notifier = new ChatSdkNotifier({ slack, discord });
    await broadcastJobOutput({
      workspaceId: WORKSPACE_ID,
      notifier,
      destinations: { slack: "C123", discord: "user:user-7" },
      sourceCommunicator: null,
      output: { markdown: "hi" },
    });
    expect(slack.postMessage).toHaveBeenCalledWith("slack:C123:", { markdown: "hi" });
    // openDM should resolve user:user-7 to a discord threadId, then post.
    expect(discord.openDM).toHaveBeenCalledWith("user-7");
    expect(discord.postMessage).toHaveBeenCalledWith("discord:@me:dm-discord", { markdown: "hi" });
  });

  it("skips the source communicator", async () => {
    const slack = makeMockAdapter("slack");
    const discord = makeMockAdapter("discord");
    const notifier = new ChatSdkNotifier({ slack, discord });
    await broadcastJobOutput({
      workspaceId: WORKSPACE_ID,
      notifier,
      destinations: { slack: "C123", discord: "user:user-7" },
      sourceCommunicator: "discord",
      output: { markdown: "hi" },
    });
    expect(slack.postMessage).toHaveBeenCalledTimes(1);
    expect(discord.postMessage).not.toHaveBeenCalled();
    expect(discord.openDM).not.toHaveBeenCalled();
  });

  it("silently skips kinds without a destination", async () => {
    const slack = makeMockAdapter("slack");
    const discord = makeMockAdapter("discord");
    const notifier = new ChatSdkNotifier({ slack, discord });
    await broadcastJobOutput({
      workspaceId: WORKSPACE_ID,
      notifier,
      destinations: { slack: "C123" }, // no discord destination
      sourceCommunicator: null,
      output: { markdown: "hi" },
    });
    expect(slack.postMessage).toHaveBeenCalledTimes(1);
    expect(discord.postMessage).not.toHaveBeenCalled();
  });

  it("passes through full threadIds unchanged when destination starts with `<kind>:`", async () => {
    const slack = makeMockAdapter("slack");
    const notifier = new ChatSdkNotifier({ slack });
    await broadcastJobOutput({
      workspaceId: WORKSPACE_ID,
      notifier,
      destinations: { slack: "slack:C9:T9" },
      sourceCommunicator: null,
      output: { markdown: "hi" },
    });
    expect(slack.postMessage).toHaveBeenCalledWith("slack:C9:T9", { markdown: "hi" });
  });

  it("formats raw channel IDs into top-level-post threadIds", async () => {
    const slack = makeMockAdapter("slack");
    const notifier = new ChatSdkNotifier({ slack });
    await broadcastJobOutput({
      workspaceId: WORKSPACE_ID,
      notifier,
      destinations: { slack: "C0A7U3YK33K" },
      sourceCommunicator: null,
      output: { markdown: "hi" },
    });
    expect(slack.postMessage).toHaveBeenCalledWith("slack:C0A7U3YK33K:", { markdown: "hi" });
  });

  it("isolates openDM failures — other platforms still broadcast", async () => {
    const slack = makeMockAdapter("slack");
    const discord = makeMockAdapter("discord", {
      openDMError: new Error("Discord 429: rate limited"),
    });
    const notifier = new ChatSdkNotifier({ slack, discord });
    await broadcastJobOutput({
      workspaceId: WORKSPACE_ID,
      notifier,
      destinations: { slack: "C123", discord: "user:user-7" },
      sourceCommunicator: null,
      output: { markdown: "hi" },
    });
    expect(slack.postMessage).toHaveBeenCalledTimes(1);
    expect(discord.postMessage).not.toHaveBeenCalled();
  });

  it("isolates postMessage failures — other platforms still broadcast", async () => {
    const slack = makeMockAdapter("slack", { postError: new Error("Slack rate limited") });
    const discord = makeMockAdapter("discord");
    const notifier = new ChatSdkNotifier({ slack, discord });
    await broadcastJobOutput({
      workspaceId: WORKSPACE_ID,
      notifier,
      destinations: { slack: "C123", discord: "user:user-7" },
      sourceCommunicator: null,
      output: { markdown: "hi" },
    });
    expect(slack.postMessage).toHaveBeenCalledTimes(1);
    expect(discord.postMessage).toHaveBeenCalledTimes(1);
  });

  it("no-ops when the notifier has nothing deliverable", async () => {
    const stub = makeMockAdapter("slack", { outboundDeliverable: false });
    const notifier = new ChatSdkNotifier({ slack: stub });
    // Notifier.list() filters the stub → broadcaster sees zero targets.
    await broadcastJobOutput({
      workspaceId: WORKSPACE_ID,
      notifier,
      destinations: { slack: "C123" },
      sourceCommunicator: null,
      output: { markdown: "hi" },
    });
    expect(stub.postMessage).not.toHaveBeenCalled();
  });
});
