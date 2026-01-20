import type { CredentialBinding, WorkspacePlan } from "@atlas/core/artifacts";
import { describe, expect, it } from "vitest";
import { generateMCPServers } from "./mcp-servers.ts";

describe("generateMCPServers credential bindings", () => {
  it("applies credential bindings by serverId", () => {
    // Use "github" - matches MCP server domain but NOT bundled agent capability
    const agents: WorkspacePlan["agents"] = [
      {
        id: "github-agent",
        name: "GitHub Agent",
        description: "Manages GitHub repos",
        needs: ["github"],
      },
    ];

    const credentials: CredentialBinding[] = [
      {
        targetType: "mcp",
        serverId: "github",
        field: "GH_CLASSIC_PAT",
        credentialId: "cred_github123",
        provider: "github",
        key: "access_token",
      },
    ];

    const servers = generateMCPServers(agents, credentials);

    const githubServer = servers.find((s) => s.id === "github");
    expect(githubServer?.config.env?.GH_CLASSIC_PAT).toEqual({
      from: "link",
      id: "cred_github123",
      key: "access_token",
    });
  });

  it("ignores bindings for servers not in result", () => {
    // Agent needs "linear" which maps to linear MCP server
    const agents: WorkspacePlan["agents"] = [
      { id: "linear-agent", name: "Linear Agent", description: "Tracks issues", needs: ["linear"] },
    ];

    // Binding for github server - but agent doesn't need github
    const credentials: CredentialBinding[] = [
      {
        targetType: "mcp",
        serverId: "github",
        field: "GH_CLASSIC_PAT",
        credentialId: "cred_github123",
        provider: "github",
        key: "access_token",
      },
    ];

    const servers = generateMCPServers(agents, credentials);

    // No github server in result, binding not applied
    const githubServer = servers.find((s) => s.id === "github");
    expect(githubServer).toBeUndefined();

    // Linear server should exist (but no binding for it)
    const linearServer = servers.find((s) => s.id === "linear");
    expect(linearServer).toBeDefined();
  });
});
