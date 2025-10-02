import type { MCPServerConfig } from "@atlas/config";
import { anthropic } from "@atlas/core";
import { generateObject } from "ai";
import { z } from "zod";
import { blessedMCPServers } from "./mcp-server-registry.ts";

const systemPrompt = `<role>
You pick MCP servers that agents need.
</role>

<context>
Atlas workspaces use MCP servers to give agents tool access.
You receive a list of MCP domain requirements and must select the appropriate servers.
</context>

<instructions>
1. Check agent MCP requirements
2. Find matching available_mcp_servers for each requirement
3. Return list of MCP Server IDs
4. Only include servers agents actually need
5. Add unmatched domains to missingDomains array
</instructions>

<evaluation_criteria>
1. If the requested domain is a piece of software or a company (e.g., Slack, GitHub), look for an exact match
2. If the requested domain is more abstract (e.g., "date", "time"), select a server that can provide that functionality
</evaluation_criteria>

<available_mcp_servers>
${Object.values(blessedMCPServers)
  .map(
    (server) =>
      `${server.name}: ${server.description}
ID: ${server.id}
Expertise domains: ${server.domains.join(", ")}
Available functionality: ${server.tools.map((t: { description: string }) => t.description).join(", ")}
`,
  )
  .join("\n")}
</available_mcp_servers>`;

export async function generateMCPServers(
  mcpDomains: string[],
  abortSignal?: AbortSignal,
): Promise<Array<{ id: string; config: MCPServerConfig }>> {
  if (mcpDomains.length === 0) {
    return [];
  }

  const { object } = await generateObject({
    model: anthropic("claude-3-5-haiku-latest"),
    schema: z.object({
      serverIds: z.string().array().describe("IDs of MCP servers to include in the workspace"),
      missingDomains: z.string().array().describe("Domains that there was no matching server for"),
    }),
    system: systemPrompt,
    prompt: `The AI agents need MCP servers to meet these needs: ${mcpDomains.join(", ")}

Return a list of Server IDs that meet those needs.`,
    temperature: 0.1,
    maxRetries: 3,
    abortSignal,
  });

  return object.serverIds.map((id) => {
    const server = blessedMCPServers[id];
    if (!server) {
      throw new Error(`Unknown server ID: ${id}`);
    }
    return { id, config: server.config };
  });
}
