import { describe, expect, it } from "vitest";
import type { Agent } from "../types.ts";
import {
  classifyAgents,
  formatClarifications,
  formatConfigRequirements,
} from "./classify-agents.ts";

/** Helper to create a minimal Agent for testing. */
function makeAgent(overrides: Partial<Agent> & { needs: string[] }): Agent {
  return {
    id: overrides.id ?? "test-agent",
    name: overrides.name ?? "Test Agent",
    description: overrides.description ?? "test",
    needs: overrides.needs,
    bundledId: overrides.bundledId,
  };
}

describe("classifyAgents", () => {
  it.each([
    { need: "email", expectedBundledId: "email" },
    { need: "slack", expectedBundledId: "slack" },
  ])("classifies agent with needs: ['$need'] as bundled:$expectedBundledId", async ({
    need,
    expectedBundledId,
  }) => {
    const agents = [makeAgent({ needs: [need] })];
    await classifyAgents(agents);
    expect(agents[0]).toMatchObject({ bundledId: expectedBundledId });
    expect(agents[0]?.mcpServers).toBeUndefined();
  });

  it.each([
    { need: "google-gmail", expectedServers: [{ serverId: "google-gmail", name: "Gmail" }] },
    {
      need: "google-calendar",
      expectedServers: [{ serverId: "google-calendar", name: "Google Calendar" }],
    },
    { need: "github", expectedServers: [{ serverId: "github", name: "GitHub" }] },
  ])("resolves MCP servers for agent with needs: ['$need']", async ({ need, expectedServers }) => {
    const agents = [makeAgent({ needs: [need] })];
    await classifyAgents(agents);
    expect(agents[0]?.bundledId).toBeUndefined();
    expect(agents[0]).toMatchObject({ mcpServers: expectedServers });
  });

  it("leaves agent with no matching needs fully unclassified", async () => {
    const agents = [makeAgent({ needs: ["unknown-thing"] })];
    await classifyAgents(agents);
    expect(agents[0]?.bundledId).toBeUndefined();
    expect(agents[0]?.mcpServers).toBeUndefined();
  });

  it("handles bundled and MCP agents coexisting", async () => {
    const agents = [
      makeAgent({ id: "emailer", needs: ["email"] }),
      makeAgent({ id: "gmail-reader", needs: ["google-gmail"] }),
    ];
    await classifyAgents(agents);
    expect(agents).toEqual([
      expect.objectContaining({ id: "emailer", bundledId: "email" }),
      expect.objectContaining({
        id: "gmail-reader",
        mcpServers: [{ serverId: "google-gmail", name: "Gmail" }],
      }),
    ]);
  });
});

describe("clarifications", () => {
  it("returns no clarifications for successfully classified agents", async () => {
    const agents = [makeAgent({ needs: ["email"] })];
    const { clarifications } = await classifyAgents(agents);
    expect(clarifications).toHaveLength(0);
  });

  it("returns no-match clarification for unknown need", async () => {
    const agents = [makeAgent({ id: "bot", name: "Bot", needs: ["unknown-thing"] })];
    const { clarifications } = await classifyAgents(agents);
    expect(clarifications).toEqual([
      expect.objectContaining({
        agentId: "bot",
        need: "unknown-thing",
        issue: { type: "no-match" },
      }),
    ]);
  });
});

describe("formatClarifications", () => {
  it("returns empty string for no clarifications", () => {
    expect(formatClarifications([])).toBe("");
  });

  it("formats no-match clarification", () => {
    const output = formatClarifications([
      { agentId: "bot", agentName: "Bot", need: "mystery", issue: { type: "no-match" } },
    ]);
    expect(output).toMatchInlineSnapshot(`
      "Agent classification issues (1):

        bot:
          need "mystery" — no matching integration found"
    `);
  });

  it("formats ambiguous-bundled clarification", () => {
    const output = formatClarifications([
      {
        agentId: "notifier",
        agentName: "Notifier",
        need: "messaging",
        issue: {
          type: "ambiguous-bundled",
          candidates: [
            { id: "slack", name: "Slack" },
            { id: "email", name: "Email" },
          ],
        },
      },
    ]);
    expect(output).toMatchInlineSnapshot(`
      "Agent classification issues (1):

        notifier:
          needs "messaging" — ambiguous, multiple bundled agents match:
            - slack: Slack
            - email: Email"
    `);
  });

  it("formats ambiguous-mcp clarification", () => {
    const output = formatClarifications([
      {
        agentId: "reader",
        agentName: "Reader",
        need: "google",
        issue: {
          type: "ambiguous-mcp",
          candidates: [
            { serverId: "google-gmail", name: "Gmail" },
            { serverId: "google-calendar", name: "Google Calendar" },
          ],
        },
      },
    ]);
    expect(output).toMatchInlineSnapshot(`
      "Agent classification issues (1):

        reader:
          need "google" — ambiguous, multiple MCP servers match:
            - google-gmail: Gmail
            - google-calendar: Google Calendar"
    `);
  });
});

describe("config requirements", () => {
  it("extracts config requirements for bundled email agent", async () => {
    const agents = [makeAgent({ id: "mailer", name: "Mailer", needs: ["email"] })];
    const { configRequirements } = await classifyAgents(agents);

    expect(configRequirements).toEqual([
      expect.objectContaining({
        agentId: "mailer",
        integration: { type: "bundled", bundledId: "email" },
        requiredConfig: expect.arrayContaining([expect.objectContaining({ source: "env" })]),
      }),
    ]);
  });

  it("extracts config requirements for MCP github agent", async () => {
    const agents = [makeAgent({ id: "gh-bot", name: "GitHub Bot", needs: ["github"] })];
    const { configRequirements } = await classifyAgents(agents);

    expect(configRequirements).toEqual([
      expect.objectContaining({
        agentId: "gh-bot",
        integration: { type: "mcp", serverId: "github" },
        requiredConfig: expect.arrayContaining([
          expect.objectContaining({ key: "GH_TOKEN", source: "link", provider: "github" }),
        ]),
      }),
    ]);
  });

  it("returns no config requirements for unknown agent", async () => {
    const agents = [makeAgent({ needs: ["unknown-thing"] })];
    const { configRequirements } = await classifyAgents(agents);
    expect(configRequirements).toHaveLength(0);
  });
});

describe("formatConfigRequirements", () => {
  it("returns empty string for no requirements", () => {
    expect(formatConfigRequirements([])).toBe("");
  });

  it("formats bundled agent config requirement", () => {
    const output = formatConfigRequirements([
      {
        agentId: "mailer",
        agentName: "Mailer",
        integration: { type: "bundled", bundledId: "email" },
        requiredConfig: [
          { key: "SENDGRID_API_KEY", description: "SendGrid API key", source: "env" },
        ],
      },
    ]);
    expect(output).toMatchInlineSnapshot(`
      "Required configuration for this workspace:

        mailer (bundled: email)
          - SENDGRID_API_KEY — SendGrid API key [env]"
    `);
  });

  it("formats MCP server config requirement with link provider", () => {
    const output = formatConfigRequirements([
      {
        agentId: "gh-bot",
        agentName: "GitHub Bot",
        integration: { type: "mcp", serverId: "github" },
        requiredConfig: [
          { key: "GH_TOKEN", description: "GitHub token", source: "link", provider: "github" },
        ],
      },
    ]);
    expect(output).toMatchInlineSnapshot(`
      "Required configuration for this workspace:

        gh-bot (mcp: github)
          - GH_TOKEN — GitHub token [link: github]"
    `);
  });
});
