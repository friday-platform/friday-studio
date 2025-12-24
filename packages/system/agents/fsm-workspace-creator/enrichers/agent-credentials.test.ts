import type { CredentialBinding } from "@atlas/core/artifacts";
import { assertEquals } from "@std/assert";
import type { ClassifiedAgent } from "../types.ts";
import { enrichAgentCredentials } from "./agent-credentials.ts";

Deno.test("enrichAgentCredentials", async (t) => {
  await t.step("applies binding to matching agent", () => {
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
    assertEquals(result[0]?.config, {
      SLACK_TOKEN: { from: "link", id: "cred-123", key: "access_token" },
    });
  });

  await t.step("skips non-matching agents", () => {
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
    assertEquals(result[0]?.config, {
      SLACK_TOKEN: { from: "link", id: "cred-123", key: "access_token" },
    });

    // github-agent should have empty config
    assertEquals(result[1]?.config, {});
  });

  await t.step("preserves existing config values", () => {
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
    assertEquals(result[0]?.config, {
      EXISTING_VAR: "existing-value",
      ANOTHER_VAR: { from: "static", value: "static-value" },
      SLACK_TOKEN: { from: "link", id: "cred-123", key: "access_token" },
    });
  });

  await t.step("ignores MCP bindings", () => {
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
    assertEquals(result[0]?.config, {});
  });

  await t.step("returns unchanged agents when credentials is undefined", () => {
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
    assertEquals(result, agents);
  });

  await t.step("returns unchanged agents when credentials is empty", () => {
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
    assertEquals(result, agents);
  });

  await t.step("applies multiple bindings to same agent", () => {
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
    assertEquals(result[0]?.config, {
      SLACK_TOKEN: { from: "link", id: "cred-123", key: "access_token" },
      SLACK_WEBHOOK: { from: "link", id: "cred-456", key: "webhook_url" },
    });
  });

  await t.step("handles mixed agent and MCP bindings", () => {
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
    assertEquals(result[0]?.config, {
      SLACK_TOKEN: { from: "link", id: "cred-123", key: "access_token" },
    });
  });
});
