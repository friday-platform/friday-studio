import { describe, expect, it } from "vitest";
import { CommunicatorConfigSchema } from "./communicators.ts";
import { WorkspaceConfigSchema } from "./workspace.ts";

describe("CommunicatorConfigSchema", () => {
  describe("valid blocks per kind", () => {
    it("parses a slack communicator", () => {
      const parsed = CommunicatorConfigSchema.parse({
        kind: "slack",
        bot_token: "xoxb-test",
        signing_secret: "shhh",
      });
      expect(parsed).toEqual({
        kind: "slack",
        bot_token: "xoxb-test",
        signing_secret: "shhh",
      });
    });

    it("parses a telegram communicator", () => {
      const parsed = CommunicatorConfigSchema.parse({
        kind: "telegram",
        bot_token: "123:abc",
      });
      expect(parsed).toEqual({ kind: "telegram", bot_token: "123:abc" });
    });

    it("parses a discord communicator", () => {
      const parsed = CommunicatorConfigSchema.parse({
        kind: "discord",
        bot_token: "discord-token",
        application_id: "app-id",
      });
      expect(parsed).toEqual({
        kind: "discord",
        bot_token: "discord-token",
        application_id: "app-id",
      });
    });

    it("parses a teams communicator", () => {
      const parsed = CommunicatorConfigSchema.parse({
        kind: "teams",
        app_id: "azure-app-id",
        app_type: "MultiTenant",
      });
      expect(parsed).toEqual({
        kind: "teams",
        app_id: "azure-app-id",
        app_type: "MultiTenant",
      });
    });

    it("parses a whatsapp communicator", () => {
      const parsed = CommunicatorConfigSchema.parse({
        kind: "whatsapp",
        access_token: "meta-token",
        phone_number_id: "555",
      });
      expect(parsed).toEqual({
        kind: "whatsapp",
        access_token: "meta-token",
        phone_number_id: "555",
      });
    });
  });

  describe("rejection", () => {
    it("rejects missing discriminator", () => {
      const result = CommunicatorConfigSchema.safeParse({ bot_token: "xoxb-test" });
      expect(result.success).toBe(false);
    });

    it("rejects unknown kind", () => {
      const result = CommunicatorConfigSchema.safeParse({
        kind: "email",
        address: "ops@example.com",
      });
      expect(result.success).toBe(false);
    });

    it.each([
      ["slack", { kind: "slack", unexpected_field: "no" }],
      ["telegram", { kind: "telegram", unexpected_field: "no" }],
      ["discord", { kind: "discord", unexpected_field: "no" }],
      ["teams", { kind: "teams", unexpected_field: "no" }],
      ["whatsapp", { kind: "whatsapp", unexpected_field: "no" }],
    ])("rejects unknown field on %s communicator", (_label, input) => {
      const result = CommunicatorConfigSchema.safeParse(input);
      expect(result.success).toBe(false);
    });
  });
});

describe("WorkspaceConfigSchema with communicators", () => {
  it("accepts a workspace with a communicators map", () => {
    const parsed = WorkspaceConfigSchema.parse({
      version: "1.0",
      workspace: { id: "test", name: "Test" },
      communicators: {
        ops_slack: { kind: "slack", bot_token: "xoxb" },
        ops_telegram: { kind: "telegram", bot_token: "123:abc" },
      },
    });
    expect(parsed.communicators).toEqual({
      ops_slack: { kind: "slack", bot_token: "xoxb" },
      ops_telegram: { kind: "telegram", bot_token: "123:abc" },
    });
  });

  it("parses an existing workspace.yml with signals.provider and no communicators block", () => {
    const parsed = WorkspaceConfigSchema.parse({
      version: "1.0",
      workspace: { id: "legacy", name: "Legacy" },
      signals: {
        webhook: {
          provider: "http",
          description: "Inbound webhook",
          config: { path: "/hook" },
        },
        slack_inbound: {
          provider: "slack",
          description: "Slack inbound",
          config: { bot_token: "xoxb-legacy" },
        },
      },
    });
    expect(parsed.communicators).toBeUndefined();
    expect(parsed.signals?.slack_inbound?.provider).toBe("slack");
  });
});
