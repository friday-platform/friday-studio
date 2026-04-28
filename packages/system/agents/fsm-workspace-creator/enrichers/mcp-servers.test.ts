import type { CredentialBinding, WorkspacePlan } from "@atlas/core/artifacts";
import { describe, expect, it } from "vitest";
import { generateMCPServers } from "./mcp-servers.ts";

describe("generateMCPServers — registry lookup", () => {
  it("generates MCP server config for MCP capability ID", () => {
    const agents: WorkspacePlan["agents"] = [
      { id: "gh-bot", name: "GitHub Bot", description: "Manages repos", capabilities: ["github"] },
    ];

    const servers = generateMCPServers(agents);
    expect(servers).toHaveLength(1);
    expect(servers[0]?.id).toBe("github");
    expect(servers[0]?.config).toBeDefined();
  });

  it("skips bundled agent capabilities — no MCP server generated", () => {
    const agents: WorkspacePlan["agents"] = [
      { id: "mailer", name: "Mailer", description: "Sends email", capabilities: ["email"] },
    ];

    const servers = generateMCPServers(agents);
    expect(servers).toHaveLength(0);
  });

  it("skips unknown capabilities — no MCP server generated", () => {
    const agents: WorkspacePlan["agents"] = [
      { id: "bot", name: "Bot", description: "test", capabilities: ["nonexistent-thing"] },
    ];

    const servers = generateMCPServers(agents);
    expect(servers).toHaveLength(0);
  });

  it("deduplicates MCP servers across agents", () => {
    const agents: WorkspacePlan["agents"] = [
      { id: "bot-1", name: "Bot 1", description: "test", capabilities: ["github"] },
      { id: "bot-2", name: "Bot 2", description: "test", capabilities: ["github"] },
    ];

    const servers = generateMCPServers(agents);
    expect(servers).toHaveLength(1);
    expect(servers[0]?.id).toBe("github");
  });

  it("generates multiple MCP servers for different capabilities", () => {
    const agents: WorkspacePlan["agents"] = [
      { id: "bot", name: "Bot", description: "test", capabilities: ["github", "google-drive"] },
    ];

    const servers = generateMCPServers(agents);
    expect(servers).toHaveLength(2);
    expect(servers.map((s) => s.id).sort()).toEqual(["github", "google-drive"]);
  });
});

// ---------------------------------------------------------------------------
// Dynamic MCP servers — runtime-registered servers from KV
// ---------------------------------------------------------------------------

describe("generateMCPServers — dynamic server resolution", () => {
  const dynamicServer = {
    id: "custom-crm",
    name: "Custom CRM",
    securityRating: "unverified" as const,
    source: "web" as const,
    configTemplate: {
      transport: { type: "stdio" as const, command: "npx", args: ["-y", "custom-crm-mcp"] },
      env: { CRM_KEY: "placeholder" },
    },
  };

  it("generates config for dynamic MCP server", () => {
    const agents: WorkspacePlan["agents"] = [
      { id: "crm-bot", name: "CRM Bot", description: "test", capabilities: ["custom-crm"] },
    ];

    const servers = generateMCPServers(agents, undefined, { dynamicServers: [dynamicServer] });
    expect(servers).toHaveLength(1);
    expect(servers[0]?.id).toBe("custom-crm");
    expect(servers[0]?.config.transport).toMatchObject({ type: "stdio", command: "npx" });
  });

  it("skips dynamic server when not provided", () => {
    const agents: WorkspacePlan["agents"] = [
      { id: "crm-bot", name: "CRM Bot", description: "test", capabilities: ["custom-crm"] },
    ];

    const servers = generateMCPServers(agents);
    expect(servers).toHaveLength(0);
  });

  it("static registry takes precedence over dynamic server with same ID", () => {
    const dynamicGithub = { ...dynamicServer, id: "github", name: "Dynamic GitHub" };
    const agents: WorkspacePlan["agents"] = [
      { id: "gh-bot", name: "Bot", description: "test", capabilities: ["github"] },
    ];

    const servers = generateMCPServers(agents, undefined, { dynamicServers: [dynamicGithub] });
    expect(servers).toHaveLength(1);
    // Config should come from static registry, not dynamic
    expect(servers[0]?.id).toBe("github");
  });

  it("applies credential bindings to dynamic server", () => {
    const agents: WorkspacePlan["agents"] = [
      { id: "crm-bot", name: "CRM Bot", description: "test", capabilities: ["custom-crm"] },
    ];

    const credentials: CredentialBinding[] = [
      {
        targetType: "mcp",
        serverId: "custom-crm",
        field: "CRM_KEY",
        credentialId: "cred_crm",
        provider: "crm",
        key: "api_key",
      },
    ];

    const servers = generateMCPServers(agents, credentials, { dynamicServers: [dynamicServer] });
    expect(servers[0]?.config.env?.CRM_KEY).toEqual({
      from: "link",
      id: "cred_crm",
      key: "api_key",
    });
  });

  it("deduplicates dynamic servers across agents", () => {
    const agents: WorkspacePlan["agents"] = [
      { id: "bot-1", name: "Bot 1", description: "test", capabilities: ["custom-crm"] },
      { id: "bot-2", name: "Bot 2", description: "test", capabilities: ["custom-crm"] },
    ];

    const servers = generateMCPServers(agents, undefined, { dynamicServers: [dynamicServer] });
    expect(servers).toHaveLength(1);
  });
});

describe("generateMCPServers — credential bindings", () => {
  it("applies credential bindings by serverId", () => {
    const agents: WorkspacePlan["agents"] = [
      { id: "gh-bot", name: "GitHub Bot", description: "Manages repos", capabilities: ["github"] },
    ];

    const credentials: CredentialBinding[] = [
      {
        targetType: "mcp",
        serverId: "github",
        field: "GH_TOKEN",
        credentialId: "cred_github123",
        provider: "github",
        key: "access_token",
      },
    ];

    const servers = generateMCPServers(agents, credentials);

    const githubServer = servers.find((s) => s.id === "github");
    expect(githubServer?.config.env?.GH_TOKEN).toEqual({
      from: "link",
      id: "cred_github123",
      key: "access_token",
    });
  });

  it("ignores bindings for servers not in result", () => {
    const agents: WorkspacePlan["agents"] = [
      {
        id: "drive-agent",
        name: "Drive Agent",
        description: "Manages files",
        capabilities: ["google-drive"],
      },
    ];

    const credentials: CredentialBinding[] = [
      {
        targetType: "mcp",
        serverId: "github",
        field: "GH_TOKEN",
        credentialId: "cred_github123",
        provider: "github",
        key: "access_token",
      },
    ];

    const servers = generateMCPServers(agents, credentials);

    const githubServer = servers.find((s) => s.id === "github");
    expect(githubServer).toBeUndefined();

    const driveServer = servers.find((s) => s.id === "google-drive");
    expect(driveServer).toBeDefined();
  });
});
