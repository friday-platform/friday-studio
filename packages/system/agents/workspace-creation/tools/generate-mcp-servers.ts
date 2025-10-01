import { anthropic } from "@ai-sdk/anthropic";
import type { Logger } from "@atlas/logger";
import { generateObject, tool } from "ai";
import { z } from "zod";
import type { WorkspaceBuilder } from "../builder.ts";
import { blessedMCPServers } from "./mcp-server-registry.ts";

const systemPrompt = `
  <role>
    You pick MCP servers that agents need.
  </role>
  <context>
    Atlas workspaces use MCP servers to give agents tool access.
  </context>
  <instructions>
    1. Check agent MCP requirements.
    2. Find matching available_mcp_servers for each requirement.
    3. Return list of MCP Server IDs.
    4. Only include servers agents actually need.
    5. Add unmatched domains to missingDomains array.
  </instructions>
  <evaluation_criteria>
    1. If the requested domain is a piece of software or a company, such as Slack or GitHub, look for an exact match.
    2. If the requested domain is more abstract, such as "date" or "time", select a server that can provide that functionality.
  </evaluation_criteria>

  <available_mcp_servers>
  ${Object.values(blessedMCPServers)
    .map(
      (server) => `${server.name}: ${server.description}\n
    ID: ${server.id}\n
    Expertise domains: ${server.domains.join(", ")}\n
    Available functionality: ${server.tools.map((t) => t.description).join(", ")}\n`,
    )
    .join("\n")}
  </available_mcp_servers>
  `;

export function getGenerateMCPServersTool(
  builder: WorkspaceBuilder,
  logger: Logger,
  abortSignal?: AbortSignal,
) {
  return tool({
    description: "Generates MCP server configurations based on agent requirements",
    inputSchema: z.object({
      requirements: z
        .string()
        .meta({
          description: "The high-level objectives of the workspace that may relate to tool usage.",
        }),
      taskSummary: z.string(),
    }),
    execute: async ({ requirements }) => {
      const neededMCPDomains = builder.mcpDomainRequirements;
      if (neededMCPDomains.length === 0) {
        return { count: 0, serverIds: [] };
      }

      logger.debug("Generating MCP servers...");
      const { object } = await generateObject({
        model: anthropic("claude-3-5-haiku-latest"),
        schema: z.object({
          serverIds: z
            .string()
            .array()
            .meta({ description: "IDs of MCP servers to include in the workspace" }),
          missingDomains: z
            .string()
            .array()
            .meta({ description: "Domains that there was no matching server for" }),
        }),
        system: systemPrompt,
        prompt: `
        The user is trying to accomplish: ${requirements}.
        In order to accomplish this, their AI agents need MCP servers to meet these needs: ${neededMCPDomains.join(", ")}
        Return a list of Server IDs that meet those needs.`,
        temperature: 0.1,
        maxRetries: 3,
        abortSignal,
      });

      const servers = object.serverIds.map((id) => {
        const server = blessedMCPServers[id];
        if (!server) {
          throw new Error(`Unknown server ID: ${id}`);
        }
        return { id, config: server.config };
      });
      builder.addMCPServers(servers);

      return {
        count: servers.length,
        serverIds: servers.map((s) => s.id),
        missingDomains: object.missingDomains,
      };
    },
  });
}
