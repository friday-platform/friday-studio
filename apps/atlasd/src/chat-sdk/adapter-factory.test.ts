import { SlackAdapter } from "@chat-adapter/slack";
import { describe, expect, it } from "vitest";
import type { StreamRegistry } from "../stream-registry.ts";
import type { ChatSdkAdapterConfig, PlatformCredentials } from "./adapter-factory.ts";
import { buildChatSdkAdapters } from "./adapter-factory.ts";
import { AtlasWebAdapter } from "./atlas-web-adapter.ts";

const stubStreamRegistry = {} as StreamRegistry;
const slackCreds: PlatformCredentials = {
  botToken: "xoxb-test",
  signingSecret: "secret",
  appId: "A12345",
};
const slackSignals = { "slack-msgs": { provider: "slack", config: { app_id: "A12345" } } };
const httpSignals = {
  webhook: { provider: "http", config: { path: "/hook" } },
  cron: { provider: "schedule", config: { schedule: "0 * * * *" } },
};

function build(overrides: Partial<ChatSdkAdapterConfig> = {}) {
  return buildChatSdkAdapters({
    workspaceId: "ws-test",
    streamRegistry: stubStreamRegistry,
    ...overrides,
  });
}

describe("buildChatSdkAdapters", () => {
  it.each([
    { name: "no signals", config: {}, expected: ["atlas"] },
    { name: "non-chat signals only", config: { signals: httpSignals }, expected: ["atlas"] },
    {
      name: "slack signal without credentials (graceful degradation)",
      config: { signals: slackSignals },
      expected: ["atlas"],
    },
    {
      name: "unknown platform provider",
      config: {
        signals: { discord: { provider: "discord", config: {} } },
        credentials: slackCreds,
      },
      expected: ["atlas"],
    },
    {
      name: "slack signal + credentials",
      config: { signals: slackSignals, credentials: slackCreds },
      expected: ["atlas", "slack"],
    },
  ])("$name → adapters: $expected", ({ config, expected }) => {
    const adapters = build(config);
    expect(Object.keys(adapters).sort()).toEqual([...expected].sort());
    expect(adapters.atlas).toBeInstanceOf(AtlasWebAdapter);
    if (expected.includes("slack")) {
      expect(adapters.slack).toBeInstanceOf(SlackAdapter);
    }
  });
});
