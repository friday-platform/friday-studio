import { describe, expect, it } from "vitest";
import type { Agent } from "../types.ts";
import {
  classifyAgents,
  formatClarifications,
  formatConfigRequirements,
} from "./classify-agents.ts";

/** Helper to create a minimal Agent for testing. */
function makeAgent(overrides: Partial<Agent> & { capabilities: string[] }): Agent {
  return {
    id: overrides.id ?? "test-agent",
    name: overrides.name ?? "Test Agent",
    description: overrides.description ?? "test",
    capabilities: overrides.capabilities,
    bundledId: overrides.bundledId,
  };
}

// ---------------------------------------------------------------------------
// Registry lookup — bundled agent resolution
// ---------------------------------------------------------------------------

describe("classifyAgents — bundled agent lookup", () => {
  it.each([
    { capabilityId: "email", expectedBundledId: "email" },
    { capabilityId: "slack", expectedBundledId: "slack" },
    { capabilityId: "research", expectedBundledId: "research" },
    { capabilityId: "google-calendar", expectedBundledId: "google-calendar" },
  ])("sets bundledId when capability '$capabilityId' exists in bundled registry", ({
    capabilityId,
    expectedBundledId,
  }) => {
    const agents = [makeAgent({ capabilities: [capabilityId] })];
    classifyAgents(agents);
    expect(agents[0]).toMatchObject({ bundledId: expectedBundledId });
    expect(agents[0]?.mcpServers).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Registry lookup — MCP server resolution
// ---------------------------------------------------------------------------

describe("classifyAgents — MCP server lookup", () => {
  it.each([
    {
      capabilityId: "google-gmail",
      expectedServers: [{ serverId: "google-gmail", name: "Gmail" }],
    },
    { capabilityId: "github", expectedServers: [{ serverId: "github", name: "GitHub" }] },
    {
      capabilityId: "linear",
      expectedServers: [{ serverId: "linear", name: "Linear Project Management" }],
    },
  ])("sets mcpServers when capability '$capabilityId' exists in MCP registry", ({
    capabilityId,
    expectedServers,
  }) => {
    const agents = [makeAgent({ capabilities: [capabilityId] })];
    classifyAgents(agents);
    expect(agents[0]?.bundledId).toBeUndefined();
    expect(agents[0]).toMatchObject({ mcpServers: expectedServers });
  });

  it("resolves multiple MCP capabilities to multiple servers", () => {
    const agents = [makeAgent({ capabilities: ["github", "linear"] })];
    classifyAgents(agents);
    expect(agents[0]?.mcpServers).toHaveLength(2);
    expect(agents[0]?.mcpServers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ serverId: "github" }),
        expect.objectContaining({ serverId: "linear" }),
      ]),
    );
  });
});

// ---------------------------------------------------------------------------
// Empty capabilities — plain LLM agent
// ---------------------------------------------------------------------------

describe("classifyAgents — empty capabilities", () => {
  it("leaves agent unclassified when capabilities array is empty", () => {
    const agents = [makeAgent({ capabilities: [] })];
    classifyAgents(agents);
    expect(agents[0]?.bundledId).toBeUndefined();
    expect(agents[0]?.mcpServers).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Mixed bundled + MCP in same agent → clarification
// ---------------------------------------------------------------------------

describe("classifyAgents — mixed bundled + MCP clarification", () => {
  it("emits mixed-bundled-mcp clarification when agent has both types", () => {
    const agents = [makeAgent({ id: "mixed", name: "Mixed", capabilities: ["email", "github"] })];
    const { clarifications } = classifyAgents(agents);
    expect(clarifications).toContainEqual(
      expect.objectContaining({ agentId: "mixed", issue: { type: "mixed-bundled-mcp" } }),
    );
    // Agent should be left unclassified — neither bundled nor MCP assigned
    expect(agents[0]?.bundledId).toBeUndefined();
    expect(agents[0]?.mcpServers).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Multiple bundled capabilities in same agent → clarification
// ---------------------------------------------------------------------------

describe("classifyAgents — multiple bundled clarification", () => {
  it("emits multiple-bundled clarification when agent has two bundled IDs", () => {
    const agents = [
      makeAgent({ id: "notifier", name: "Notifier", capabilities: ["email", "slack"] }),
    ];
    const { clarifications } = classifyAgents(agents);
    expect(clarifications).toContainEqual(
      expect.objectContaining({
        agentId: "notifier",
        issue: { type: "multiple-bundled", bundledIds: ["email", "slack"] },
      }),
    );
  });

  it("does not set bundledId when multiple bundled IDs are found", () => {
    const agents = [makeAgent({ capabilities: ["email", "slack"] })];
    classifyAgents(agents);
    expect(agents[0]?.bundledId).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Unknown capability → clarification
// ---------------------------------------------------------------------------

describe("classifyAgents — unknown capability clarification", () => {
  it("emits unknown-capability clarification for unrecognized ID", () => {
    const agents = [makeAgent({ id: "bot", name: "Bot", capabilities: ["nonexistent-thing"] })];
    const { clarifications } = classifyAgents(agents);
    expect(clarifications).toEqual([
      expect.objectContaining({
        agentId: "bot",
        issue: { type: "unknown-capability", capabilityId: "nonexistent-thing" },
      }),
    ]);
  });

  it("leaves agent unclassified when capability is unknown", () => {
    const agents = [makeAgent({ capabilities: ["nonexistent-thing"] })];
    classifyAgents(agents);
    expect(agents[0]?.bundledId).toBeUndefined();
    expect(agents[0]?.mcpServers).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Mixed/multiple-bundled with unknown IDs — emits both clarifications
// ---------------------------------------------------------------------------

describe("classifyAgents — unknown IDs alongside mixed/multiple-bundled", () => {
  it("emits unknown-capability + mixed-bundled-mcp for mixed combo with unknown", () => {
    const agents = [
      makeAgent({ id: "combo", name: "Combo", capabilities: ["email", "github", "nonexistent"] }),
    ];
    const { clarifications } = classifyAgents(agents);

    expect(clarifications).toHaveLength(2);
    expect(clarifications[0]).toMatchObject({
      agentId: "combo",
      issue: { type: "unknown-capability", capabilityId: "nonexistent" },
    });
    expect(clarifications[1]).toMatchObject({
      agentId: "combo",
      issue: { type: "mixed-bundled-mcp" },
    });
  });

  it("emits unknown-capability + multiple-bundled for multi-bundled combo with unknown", () => {
    const agents = [
      makeAgent({
        id: "notifier",
        name: "Notifier",
        capabilities: ["email", "slack", "nonexistent"],
      }),
    ];
    const { clarifications } = classifyAgents(agents);

    expect(clarifications).toHaveLength(2);
    expect(clarifications[0]).toMatchObject({
      agentId: "notifier",
      issue: { type: "unknown-capability", capabilityId: "nonexistent" },
    });
    expect(clarifications[1]).toMatchObject({
      agentId: "notifier",
      issue: { type: "multiple-bundled", bundledIds: ["email", "slack"] },
    });
  });
});

// ---------------------------------------------------------------------------
// Valid MCP + unknown combo — classifies known and flags unknown
// ---------------------------------------------------------------------------

describe("classifyAgents — valid MCP + unknown combo", () => {
  it("resolves known MCP server and emits unknown-capability for unrecognized ID", () => {
    const agents = [
      makeAgent({ id: "hybrid", name: "Hybrid", capabilities: ["github", "nonexistent-thing"] }),
    ];
    const { clarifications } = classifyAgents(agents);

    // Known MCP server should be resolved
    expect(agents[0]).toMatchObject({ mcpServers: [{ serverId: "github" }] });

    // Unknown capability should be flagged
    expect(clarifications).toContainEqual(
      expect.objectContaining({
        agentId: "hybrid",
        issue: { type: "unknown-capability", capabilityId: "nonexistent-thing" },
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Dynamic MCP servers — runtime-registered servers from KV
// ---------------------------------------------------------------------------

describe("classifyAgents — dynamic MCP server resolution", () => {
  const dynamicServer = {
    id: "custom-crm",
    name: "Custom CRM",
    securityRating: "unverified" as const,
    source: "web" as const,
    configTemplate: {
      transport: { type: "stdio" as const, command: "npx", args: ["-y", "custom-crm-mcp"] },
    },
  };

  it("resolves dynamic MCP server ID to mcpServers", () => {
    const agents = [makeAgent({ id: "crm-bot", name: "CRM Bot", capabilities: ["custom-crm"] })];
    const { clarifications } = classifyAgents(agents, { dynamicServers: [dynamicServer] });
    expect(agents[0]).toMatchObject({
      mcpServers: [{ serverId: "custom-crm", name: "Custom CRM" }],
    });
    expect(clarifications).toHaveLength(0);
  });

  it("emits unknown-capability when dynamic server not provided", () => {
    const agents = [makeAgent({ id: "crm-bot", name: "CRM Bot", capabilities: ["custom-crm"] })];
    const { clarifications } = classifyAgents(agents);
    expect(clarifications).toEqual([
      expect.objectContaining({
        agentId: "crm-bot",
        issue: { type: "unknown-capability", capabilityId: "custom-crm" },
      }),
    ]);
  });

  it("static registry takes precedence over dynamic server with same ID", () => {
    const dynamicGithub = { ...dynamicServer, id: "github", name: "Dynamic GitHub" };
    const agents = [makeAgent({ capabilities: ["github"] })];
    classifyAgents(agents, { dynamicServers: [dynamicGithub] });
    // Should resolve from static registry, not dynamic
    expect(agents[0]).toMatchObject({ mcpServers: [{ serverId: "github", name: "GitHub" }] });
  });

  it("extracts config requirements for dynamic MCP server", () => {
    const dynamicWithConfig = {
      ...dynamicServer,
      requiredConfig: [{ key: "CRM_API_KEY", description: "CRM API key", type: "string" as const }],
      configTemplate: {
        transport: { type: "stdio" as const, command: "npx", args: ["-y", "custom-crm-mcp"] },
        env: { CRM_API_KEY: "placeholder" },
      },
    };
    const agents = [makeAgent({ id: "crm-bot", name: "CRM Bot", capabilities: ["custom-crm"] })];
    const { configRequirements } = classifyAgents(agents, { dynamicServers: [dynamicWithConfig] });
    expect(configRequirements).toEqual([
      expect.objectContaining({
        agentId: "crm-bot",
        integration: { type: "mcp", serverId: "custom-crm" },
        requiredConfig: [{ key: "CRM_API_KEY", description: "CRM API key", source: "env" }],
      }),
    ]);
  });

  it("handles mixed static + dynamic capabilities on one agent", () => {
    const agents = [makeAgent({ id: "multi", capabilities: ["github", "custom-crm"] })];
    classifyAgents(agents, { dynamicServers: [dynamicServer] });
    expect(agents[0]?.mcpServers).toHaveLength(2);
    expect(agents[0]?.mcpServers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ serverId: "github" }),
        expect.objectContaining({ serverId: "custom-crm" }),
      ]),
    );
  });
});

// ---------------------------------------------------------------------------
// Coexistence — bundled and MCP agents in same batch
// ---------------------------------------------------------------------------

describe("classifyAgents — multiple agents coexisting", () => {
  it("handles bundled and MCP agents in same batch", () => {
    const agents = [
      makeAgent({ id: "emailer", capabilities: ["email"] }),
      makeAgent({ id: "gh-bot", capabilities: ["github"] }),
    ];
    classifyAgents(agents);
    expect(agents).toEqual([
      expect.objectContaining({ id: "emailer", bundledId: "email" }),
      expect.objectContaining({
        id: "gh-bot",
        mcpServers: [{ serverId: "github", name: "GitHub" }],
      }),
    ]);
  });
});

// ---------------------------------------------------------------------------
// Config requirements
// ---------------------------------------------------------------------------

describe("classifyAgents — config requirements", () => {
  it("extracts config requirements for bundled email agent", () => {
    const agents = [makeAgent({ id: "mailer", name: "Mailer", capabilities: ["email"] })];
    const { configRequirements } = classifyAgents(agents);

    expect(configRequirements).toEqual([
      expect.objectContaining({
        agentId: "mailer",
        integration: { type: "bundled", bundledId: "email" },
        requiredConfig: expect.arrayContaining([expect.objectContaining({ source: "env" })]),
      }),
    ]);
  });

  it("extracts config requirements for MCP github agent", () => {
    const agents = [makeAgent({ id: "gh-bot", name: "GitHub Bot", capabilities: ["github"] })];
    const { configRequirements } = classifyAgents(agents);

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

  it("returns no config requirements for unknown capability", () => {
    const agents = [makeAgent({ capabilities: ["nonexistent-thing"] })];
    const { configRequirements } = classifyAgents(agents);
    expect(configRequirements).toHaveLength(0);
  });

  it("returns no config requirements for empty capabilities", () => {
    const agents = [makeAgent({ capabilities: [] })];
    const { configRequirements } = classifyAgents(agents);
    expect(configRequirements).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Format helpers (unchanged — pure functions, just verify they still work)
// ---------------------------------------------------------------------------

describe("formatClarifications", () => {
  it("returns empty string for no clarifications", () => {
    expect(formatClarifications([])).toBe("");
  });

  it("formats unknown-capability clarification", () => {
    const output = formatClarifications([
      {
        agentId: "bot",
        agentName: "Bot",
        capability: "mystery",
        issue: { type: "unknown-capability", capabilityId: "mystery" },
      },
    ]);
    expect(output).toMatchInlineSnapshot(`
      "Agent classification issues (1):

        bot:
          capability "mystery" — not found in any registry"
    `);
  });

  it("formats mixed-bundled-mcp clarification", () => {
    const output = formatClarifications([
      {
        agentId: "notifier",
        agentName: "Notifier",
        capability: "email, github",
        issue: { type: "mixed-bundled-mcp" },
      },
    ]);
    expect(output).toMatchInlineSnapshot(`
      "Agent classification issues (1):

        notifier:
          capabilities "email, github" — mixes bundled agent and MCP server IDs"
    `);
  });

  it("formats multiple-bundled clarification", () => {
    const output = formatClarifications([
      {
        agentId: "notifier",
        agentName: "Notifier",
        capability: "email, slack",
        issue: { type: "multiple-bundled", bundledIds: ["email", "slack"] },
      },
    ]);
    expect(output).toMatchInlineSnapshot(`
      "Agent classification issues (1):

        notifier:
          capabilities "email, slack" — uses multiple bundled agents (email, slack), split into separate agents"
    `);
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
