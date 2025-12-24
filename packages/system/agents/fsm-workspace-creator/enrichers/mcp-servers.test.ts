import type { CredentialBinding, WorkspacePlan } from "@atlas/core/artifacts";
import { assertEquals } from "@std/assert";
import { generateMCPServers } from "./mcp-servers.ts";

Deno.test("generateMCPServers credential bindings", async (t) => {
  await t.step("applies credential bindings by serverId", () => {
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
    assertEquals(githubServer?.config.env?.GH_CLASSIC_PAT, {
      from: "link",
      id: "cred_github123",
      key: "access_token",
    });
  });

  await t.step("ignores bindings for servers not in result", () => {
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
    assertEquals(githubServer, undefined);

    // Linear server should exist (but no binding for it)
    const linearServer = servers.find((s) => s.id === "linear");
    assertEquals(linearServer !== undefined, true);
  });
});
