import { SlackAdapter } from "@chat-adapter/slack";
import { TeamsAdapter } from "@chat-adapter/teams";
import { describe, expect, it } from "vitest";
import type { StreamRegistry } from "../stream-registry.ts";
import type { ChatSdkAdapterConfig, PlatformCredentials } from "./adapter-factory.ts";
import { buildChatSdkAdapters } from "./adapter-factory.ts";
import { AtlasWebAdapter } from "./atlas-web-adapter.ts";

const stubStreamRegistry = {} as StreamRegistry;
const slackCreds: PlatformCredentials = {
  kind: "slack",
  botToken: "xoxb-test",
  signingSecret: "secret",
  appId: "A12345",
};
const telegramCreds: PlatformCredentials = {
  kind: "telegram",
  botToken: "111:abc",
  secretToken: "sec",
  appId: "111",
};
const whatsappCreds: PlatformCredentials = {
  kind: "whatsapp",
  accessToken: "access",
  appSecret: "secret",
  phoneNumberId: "111",
  verifyToken: "verify",
};
const teamsCreds: PlatformCredentials = { kind: "teams", appId: "app-id", appPassword: "app-pw" };
const teamsSignals = { "teams-chat": { provider: "teams", config: { app_id: "app-id" } } };
const slackSignals = { "slack-msgs": { provider: "slack", config: { app_id: "A12345" } } };
const httpSignals = {
  webhook: { provider: "http", config: { path: "/hook" } },
  cron: { provider: "schedule", config: { schedule: "0 * * * *" } },
};
const tgWaSignals = {
  "telegram-chat": { provider: "telegram", config: { bot_token: "111:abc" } },
  "whatsapp-chat": { provider: "whatsapp", config: {} },
};

function build(overrides: Partial<ChatSdkAdapterConfig> = {}) {
  return buildChatSdkAdapters({
    workspaceId: "ws-test",
    streamRegistry: stubStreamRegistry,
    ...overrides,
  });
}

interface AdapterCase {
  name: string;
  config: Partial<ChatSdkAdapterConfig>;
  expected: string[];
}

describe("buildChatSdkAdapters", () => {
  it.each<AdapterCase>([
    { name: "no signals", config: {}, expected: ["atlas"] },
    { name: "non-chat signals only", config: { signals: httpSignals }, expected: ["atlas"] },
    {
      name: "slack signal without credentials (graceful degradation)",
      config: { signals: slackSignals },
      expected: ["atlas"],
    },
    {
      name: "unknown platform provider",
      config: { signals: { matrix: { provider: "matrix", config: {} } }, credentials: slackCreds },
      expected: ["atlas"],
    },
    {
      name: "slack signal + credentials",
      config: { signals: slackSignals, credentials: slackCreds },
      expected: ["atlas", "slack"],
    },
    {
      name: "telegram + whatsapp signals + both credentials",
      config: { signals: tgWaSignals, credentials: [telegramCreds, whatsappCreds] },
      expected: ["atlas", "telegram", "whatsapp"],
    },
    {
      name: "telegram + whatsapp signals, only telegram creds (partial resolution)",
      config: { signals: tgWaSignals, credentials: [telegramCreds] },
      expected: ["atlas", "telegram"],
    },
    {
      name: "telegram + whatsapp signals, only whatsapp creds (partial resolution)",
      config: { signals: tgWaSignals, credentials: [whatsappCreds] },
      expected: ["atlas", "whatsapp"],
    },
    {
      name: "credentials for provider whose signal is absent (dropped, no adapter)",
      config: { signals: httpSignals, credentials: telegramCreds },
      expected: ["atlas"],
    },
    {
      name: "empty credentials array with chat signal (same as no creds)",
      config: { signals: tgWaSignals, credentials: [] },
      expected: ["atlas"],
    },
    {
      name: "duplicate-kind credentials (last-wins, no crash)",
      config: {
        signals: { "whatsapp-chat": { provider: "whatsapp", config: {} } },
        credentials: [whatsappCreds, { ...whatsappCreds, phoneNumberId: "222" }],
      },
      expected: ["atlas", "whatsapp"],
    },
    {
      name: "teams signal + credentials",
      config: { signals: teamsSignals, credentials: teamsCreds },
      expected: ["atlas", "teams"],
    },
  ])("$name → adapters: $expected", ({ config, expected }) => {
    const adapters = build(config);
    expect(Object.keys(adapters).sort()).toEqual([...expected].sort());
    expect(adapters.atlas).toBeInstanceOf(AtlasWebAdapter);
    if (expected.includes("slack")) {
      expect(adapters.slack).toBeInstanceOf(SlackAdapter);
    }
    if (expected.includes("teams")) {
      expect(adapters.teams).toBeInstanceOf(TeamsAdapter);
    }
  });
});

describe("buildChatSdkAdapters — communicators map", () => {
  it("discovers a kind declared only in communicators (no signal of that provider)", () => {
    const adapters = build({
      communicators: { ops: { kind: "telegram", bot_token: "111:abc" } },
      credentials: telegramCreds,
    });
    expect(Object.keys(adapters).sort()).toEqual(["atlas", "telegram"]);
  });

  it("falls back to signals when a kind is absent from communicators", () => {
    const adapters = build({
      communicators: { ops: { kind: "telegram", bot_token: "111:abc" } },
      signals: slackSignals,
      credentials: [telegramCreds, slackCreds],
    });
    expect(Object.keys(adapters).sort()).toEqual(["atlas", "slack", "telegram"]);
  });

  it("does not double-construct when the same kind is declared in both", () => {
    const adapters = build({
      communicators: { ops: { kind: "slack", bot_token: "xoxb-top" } },
      signals: slackSignals,
      credentials: slackCreds,
    });
    expect(Object.keys(adapters).sort()).toEqual(["atlas", "slack"]);
  });

  it("ignores communicator entries with non-chat kinds", () => {
    const adapters = build({
      communicators: { mail: { kind: "email", address: "ops@example.com" } },
      credentials: [],
    });
    expect(Object.keys(adapters).sort()).toEqual(["atlas"]);
  });

  it("returns only atlas when communicators is empty and signals are absent", () => {
    const adapters = build({ communicators: {} });
    expect(Object.keys(adapters).sort()).toEqual(["atlas"]);
  });
});
