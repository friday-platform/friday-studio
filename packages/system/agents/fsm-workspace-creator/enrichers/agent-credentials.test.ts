import type { CredentialBinding } from "@atlas/core/artifacts";
import { describe, expect, it } from "vitest";
import type { ClassifiedAgent } from "../types.ts";
import { enrichAgentCredentials } from "./agent-credentials.ts";

describe("enrichAgentCredentials", () => {
  it("applies binding to matching agent", () => {
    const agents: ClassifiedAgent[] = [
      {
        id: "slack-agent",
        name: "Slack Agent",
        description: "Manages Slack communications",
        config: {},
        type: { kind: "bundled", bundledId: "slack", name: "Slack" },
      },
    ];

    const bindings: CredentialBinding[] = [
      {
        targetType: "agent",
        agentId: "slack-agent",
        field: "SLACK_TOKEN",
        credentialId: "cred-123",
        provider: "slack",
        key: "access_token",
      },
    ];

    const result = enrichAgentCredentials(agents, bindings);
    expect(result[0]?.config).toEqual({
      SLACK_TOKEN: { from: "link", id: "cred-123", key: "access_token" },
    });
  });

  it("skips non-matching agents", () => {
    const agents: ClassifiedAgent[] = [
      {
        id: "slack-agent",
        name: "Slack Agent",
        description: "Manages Slack communications",
        config: {},
        type: { kind: "bundled", bundledId: "slack", name: "Slack" },
      },
      {
        id: "github-agent",
        name: "GitHub Agent",
        description: "Manages GitHub repos",
        config: {},
        type: { kind: "bundled", bundledId: "github", name: "GitHub" },
      },
    ];

    const bindings: CredentialBinding[] = [
      {
        targetType: "agent",
        agentId: "slack-agent",
        field: "SLACK_TOKEN",
        credentialId: "cred-123",
        provider: "slack",
        key: "access_token",
      },
    ];

    const result = enrichAgentCredentials(agents, bindings);

    // slack-agent should have config with credential
    expect(result[0]?.config).toEqual({
      SLACK_TOKEN: { from: "link", id: "cred-123", key: "access_token" },
    });

    // github-agent should have empty config
    expect(result[1]?.config).toEqual({});
  });

  it("preserves existing config values", () => {
    const agents: ClassifiedAgent[] = [
      {
        id: "slack-agent",
        name: "Slack Agent",
        description: "Manages Slack communications",
        config: {
          EXISTING_VAR: "existing-value",
          ANOTHER_VAR: { from: "static", value: "static-value" },
        },
        type: { kind: "bundled", bundledId: "slack", name: "Slack" },
      },
    ];

    const bindings: CredentialBinding[] = [
      {
        targetType: "agent",
        agentId: "slack-agent",
        field: "SLACK_TOKEN",
        credentialId: "cred-123",
        provider: "slack",
        key: "access_token",
      },
    ];

    const result = enrichAgentCredentials(agents, bindings);
    expect(result[0]?.config).toEqual({
      EXISTING_VAR: "existing-value",
      ANOTHER_VAR: { from: "static", value: "static-value" },
      SLACK_TOKEN: { from: "link", id: "cred-123", key: "access_token" },
    });
  });

  it("ignores MCP bindings", () => {
    const agents: ClassifiedAgent[] = [
      {
        id: "slack-agent",
        name: "Slack Agent",
        description: "Manages Slack communications",
        config: {},
        type: { kind: "bundled", bundledId: "slack", name: "Slack" },
      },
    ];

    const bindings: CredentialBinding[] = [
      {
        targetType: "mcp",
        serverId: "slack",
        field: "SLACK_TOKEN",
        credentialId: "cred-123",
        provider: "slack",
        key: "access_token",
      },
    ];

    const result = enrichAgentCredentials(agents, bindings);
    expect(result[0]?.config).toEqual({});
  });

  it("returns unchanged agents when credentials is undefined", () => {
    const agents: ClassifiedAgent[] = [
      {
        id: "slack-agent",
        name: "Slack Agent",
        description: "Manages Slack communications",
        config: { EXISTING: "value" },
        type: { kind: "bundled", bundledId: "slack", name: "Slack" },
      },
    ];

    const result = enrichAgentCredentials(agents, undefined);
    expect(result).toEqual(agents);
  });

  it("returns unchanged agents when credentials is empty", () => {
    const agents: ClassifiedAgent[] = [
      {
        id: "slack-agent",
        name: "Slack Agent",
        description: "Manages Slack communications",
        config: { EXISTING: "value" },
        type: { kind: "bundled", bundledId: "slack", name: "Slack" },
      },
    ];

    const result = enrichAgentCredentials(agents, []);
    expect(result).toEqual(agents);
  });

  it("applies multiple bindings to same agent", () => {
    const agents: ClassifiedAgent[] = [
      {
        id: "slack-agent",
        name: "Slack Agent",
        description: "Manages Slack communications",
        config: {},
        type: { kind: "bundled", bundledId: "slack", name: "Slack" },
      },
    ];

    const bindings: CredentialBinding[] = [
      {
        targetType: "agent",
        agentId: "slack-agent",
        field: "SLACK_TOKEN",
        credentialId: "cred-123",
        provider: "slack",
        key: "access_token",
      },
      {
        targetType: "agent",
        agentId: "slack-agent",
        field: "SLACK_WEBHOOK",
        credentialId: "cred-456",
        provider: "slack",
        key: "webhook_url",
      },
    ];

    const result = enrichAgentCredentials(agents, bindings);
    expect(result[0]?.config).toEqual({
      SLACK_TOKEN: { from: "link", id: "cred-123", key: "access_token" },
      SLACK_WEBHOOK: { from: "link", id: "cred-456", key: "webhook_url" },
    });
  });

  it("handles mixed agent and MCP bindings", () => {
    const agents: ClassifiedAgent[] = [
      {
        id: "slack-agent",
        name: "Slack Agent",
        description: "Manages Slack communications",
        config: {},
        type: { kind: "bundled", bundledId: "slack", name: "Slack" },
      },
    ];

    const bindings: CredentialBinding[] = [
      {
        targetType: "agent",
        agentId: "slack-agent",
        field: "SLACK_TOKEN",
        credentialId: "cred-123",
        provider: "slack",
        key: "access_token",
      },
      {
        targetType: "mcp",
        serverId: "slack",
        field: "SLACK_BOT_TOKEN",
        credentialId: "cred-456",
        provider: "slack",
        key: "bot_token",
      },
    ];

    const result = enrichAgentCredentials(agents, bindings);
    expect(result[0]?.config).toEqual({
      SLACK_TOKEN: { from: "link", id: "cred-123", key: "access_token" },
    });
  });
});
