import type { MCPServerMetadata } from "@atlas/core/mcp-registry/schemas";
import { describe, expect, it } from "vitest";
import type { Agent, CredentialBinding } from "../../../../../workspace-builder/types.ts";
import { buildMCPServerConfigs } from "./index.ts";

/** Minimal agent with MCP servers for testing. */
function makeAgent(overrides: Partial<Agent> & { id: string }): Agent {
  return { name: overrides.id, description: "test agent", capabilities: [], ...overrides };
}

const dynamicServer: MCPServerMetadata = {
  id: "custom-crm",
  name: "Custom CRM",
  securityRating: "unverified",
  source: "web",
  configTemplate: {
    transport: { type: "stdio", command: "npx", args: ["-y", "custom-crm-mcp"] },
    env: { CRM_KEY: "placeholder" },
  },
};

describe("buildMCPServerConfigs — dynamic MCP servers", () => {
  it("resolves dynamic server ID instead of skipping", () => {
    const agents: Agent[] = [
      makeAgent({ id: "crm-agent", mcpServers: [{ serverId: "custom-crm", name: "CRM" }] }),
    ];
    const results = buildMCPServerConfigs(agents, [], [dynamicServer]);

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      id: "custom-crm",
      config: { transport: { type: "stdio", command: "npx", args: ["-y", "custom-crm-mcp"] } },
    });
  });

  it("prefers static registry over dynamic server with same ID", () => {
    const dynamicGmail: MCPServerMetadata = {
      id: "google-gmail",
      name: "Dynamic Gmail Override",
      securityRating: "unverified",
      source: "web",
      configTemplate: {
        transport: { type: "stdio", command: "npx", args: ["-y", "dynamic-gmail"] },
      },
    };

    const agents: Agent[] = [
      makeAgent({ id: "mail-agent", mcpServers: [{ serverId: "google-gmail", name: "Gmail" }] }),
    ];
    const results = buildMCPServerConfigs(agents, [], [dynamicGmail]);

    expect(results).toHaveLength(1);
    // Static registry has transport config, not the dynamic override
    expect(results[0]?.config.transport).toBeDefined();
    expect(results[0]?.config.transport).not.toMatchObject({
      command: "npx",
      args: ["-y", "dynamic-gmail"],
    });
  });

  it("applies credential bindings to dynamic server", () => {
    const agents: Agent[] = [
      makeAgent({ id: "crm-agent", mcpServers: [{ serverId: "custom-crm", name: "CRM" }] }),
    ];
    const bindings: CredentialBinding[] = [
      {
        targetType: "mcp",
        targetId: "custom-crm",
        field: "CRM_KEY",
        credentialId: "cred_crm_123",
        provider: "custom-crm",
        key: "api_key",
      },
    ];
    const results = buildMCPServerConfigs(agents, bindings, [dynamicServer]);

    expect(results[0]?.config.env).toMatchObject({
      CRM_KEY: { from: "link", id: "cred_crm_123", key: "api_key" },
    });
  });

  it("skips server ID not in static or dynamic registry", () => {
    const agents: Agent[] = [
      makeAgent({ id: "mystery", mcpServers: [{ serverId: "totally-unknown", name: "Unknown" }] }),
    ];
    const results = buildMCPServerConfigs(agents, [], [dynamicServer]);

    expect(results).toHaveLength(0);
  });

  it("deduplicates when multiple agents reference the same MCP server", () => {
    const agents: Agent[] = [
      makeAgent({ id: "agent-a", mcpServers: [{ serverId: "custom-crm", name: "CRM" }] }),
      makeAgent({ id: "agent-b", mcpServers: [{ serverId: "custom-crm", name: "CRM" }] }),
    ];
    const results = buildMCPServerConfigs(agents, [], [dynamicServer]);

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ id: "custom-crm" });
  });
});
