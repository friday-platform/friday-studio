import type { MCPDiscoveryRequest } from "@atlas/core";
import { MCPRegistry } from "@atlas/core";
import { tool } from "ai";
import { z } from "zod/v4";

/**
 * Agent Discovery Tool for Atlas Workspace Creation Flow
 *
 * Discovers built-in agents that can handle user requirements
 * before falling back to external MCP servers
 */
export const agentDiscoveryTool = tool({
  description:
    "Discover built-in Atlas agents or MCP servers for workspace capabilities using intelligent unified search. Prioritizes built-in agents over external tools.",
  inputSchema: z.object({
    intent: z
      .string()
      .describe(
        "Natural language description of needed capabilities, e.g., 'manage GitHub repositories', 'process payments', 'automate browser testing'",
      ),
    domain: z
      .enum([
        "development",
        "cloud",
        "analytics",
        "automation",
        "communication",
        "testing",
        "security",
        "content",
        "finance",
        "utility",
      ])
      .optional()
      .describe("Category filter to narrow search scope"),
    capabilities: z
      .array(z.string())
      .optional()
      .describe(
        "Specific capabilities needed, e.g., ['file-upload', 'data-processing', 'notifications']",
      ),
  }),
  execute: async ({ intent, domain, capabilities }) => {
    try {
      const registry = await MCPRegistry.getInstance();
      const request: MCPDiscoveryRequest = { intent, domain, capabilities };

      // Perform unified discovery (agents first, then MCP servers)
      const bestSolution = await registry.discoverBestSolution(request);

      if (!bestSolution) {
        return {
          success: false,
          message: `No suitable built-in agents or MCP servers found for "${intent}"`,
          suggestions: [
            "Try a more specific or different description of your requirements",
            "Consider breaking down complex requirements into smaller, more focused needs",
            "Check if your requirements can be met with basic Atlas tools",
          ],
        };
      }

      if (bestSolution.type === "agent") {
        // Return built-in agent recommendation
        return {
          success: true,
          type: "agent",
          agent: {
            id: bestSolution.agent.id,
            name: bestSolution.agent.name,
            description: bestSolution.agent.description,
            source: bestSolution.agent.source,
            domains: bestSolution.agent.expertise.domains,
            capabilities: bestSolution.agent.expertise.capabilities,
            examples: bestSolution.agent.expertise.examples,
          },
          confidence: bestSolution.confidence,
          reasoning: bestSolution.reasoning,
          source: bestSolution.source,
          configuration: generateAgentConfiguration(bestSolution.agent.id),
          integrationInstructions: generateAgentIntegrationInstructions(bestSolution.agent),
        };
      } else {
        // Return MCP server recommendation (fallback)
        const configuration = generateMCPConfiguration(bestSolution.server);

        return {
          success: true,
          type: "mcp",
          server: {
            id: bestSolution.server.id,
            description: bestSolution.server.description,
            category: bestSolution.server.category,
            securityRating: bestSolution.server.securityRating,
            package: bestSolution.server.package,
            documentation: bestSolution.server.documentation,
          },
          confidence: bestSolution.confidence,
          reasoning: bestSolution.reasoning,
          source: bestSolution.source,
          configuration,
          useCases: bestSolution.server.useCases,
          availableTools: bestSolution.server.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            capabilities: tool.capabilities,
          })),
          integrationInstructions: generateMCPIntegrationInstructions(bestSolution.server),
        };
      }
    } catch (error) {
      return {
        success: false,
        error: `Discovery failed: ${error instanceof Error ? error.message : String(error)}`,
        message:
          "An error occurred during agent/MCP discovery. Please try again or contact support if the issue persists.",
      };
    }
  },
});

/**
 * Generate built-in agent configuration for workspace.yml
 */
function generateAgentConfiguration(agentId: string) {
  return {
    agentId,
    description: `Configuration for built-in agent: ${agentId}`,
    usage: `Add to workspace.yml:
\`\`\`yaml
agents:
  - id: "${agentId}"
    # Agent will be automatically loaded from Atlas built-in agents
    # No additional configuration needed
\`\`\``,
  };
}

/**
 * Generate MCP server configuration for workspace.yml
 */
function generateMCPConfiguration(server: {
  id: string;
  name: string;
  description: string;
  configTemplate: {
    transport: { type: string; command?: string; args?: string[] };
    auth?: { type: string; token_env?: string };
    tools: { allow?: string[] };
    env?: Record<string, string>;
    client_config?: { timeout?: string };
  };
}) {
  return {
    serverName: server.id,
    description: `${server.name} - ${server.description}`,
    configuration: server.configTemplate,
    usage: `Add to workspace.yml:
\`\`\`yaml
tools:
  mcp:
    servers:
      ${server.id}:
        transport:
          type: "${server.configTemplate.transport.type}"
          command: "${server.configTemplate.transport.command}"
          args: ${JSON.stringify(server.configTemplate.transport.args, null, 8)}
        ${
          server.configTemplate.auth
            ? `auth:
          type: "${server.configTemplate.auth.type}"
          token_env: "${server.configTemplate.auth.token_env}"`
            : ""
        }
        tools:
          allow: ${JSON.stringify(server.configTemplate.tools.allow, null, 8)}
        ${
          server.configTemplate.env
            ? `env:${Object.entries(server.configTemplate.env)
                .map(([key, value]) => `\n          ${key}: "${value}"`)
                .join("")}`
            : ""
        }
        ${
          server.configTemplate.client_config
            ? `client_config:
          timeout: "${server.configTemplate.client_config.timeout}"`
            : ""
        }
\`\`\``,
  };
}

/**
 * Generate integration instructions for built-in agents
 */
function generateAgentIntegrationInstructions(agent: {
  name: string;
  description: string;
  expertise: { domains: string[]; capabilities: string[] };
}) {
  const instructions = [`# ${agent.name} Integration\n`];

  instructions.push(`## Overview`);
  instructions.push(`${agent.description}\n`);

  if (agent.expertise.domains.length > 0) {
    instructions.push(`## Expertise Domains`);
    instructions.push(`- ${agent.expertise.domains.join("\n- ")}\n`);
  }

  if (agent.expertise.capabilities.length > 0) {
    instructions.push(`## Capabilities`);
    instructions.push(`- ${agent.expertise.capabilities.join("\n- ")}\n`);
  }

  instructions.push(`## Usage`);
  instructions.push(`This agent is built into Atlas and requires no additional setup.`);
  instructions.push(
    `Simply add it to your workspace configuration and it will be available immediately.`,
  );

  instructions.push(`\n## Benefits of Built-in Agents`);
  instructions.push(`- ✅ No external dependencies`);
  instructions.push(`- ✅ Instant availability`);
  instructions.push(`- ✅ Optimized for Atlas`);
  instructions.push(`- ✅ Regularly updated with Atlas releases`);

  return instructions.join("\n");
}

/**
 * Generate integration instructions for MCP servers
 */
function generateMCPIntegrationInstructions(server: {
  name: string;
  description: string;
  useCases?: string[];
  tools?: Array<{ name: string; description: string; capabilities?: string[] }>;
  package?: string;
  configTemplate?: { auth?: { token_env?: string }; env?: Record<string, string> };
  documentation?: string;
}) {
  const instructions = [`# ${server.name} Integration\n`];

  instructions.push(`## Overview`);
  instructions.push(`${server.description}\n`);

  if (server.useCases && server.useCases.length > 0) {
    instructions.push(`## Use Cases`);
    instructions.push(`- ${server.useCases.join("\n- ")}\n`);
  }

  if (server.tools && server.tools.length > 0) {
    instructions.push(`## Available Tools`);
    server.tools.forEach((tool: { name: string; description: string; capabilities?: string[] }) => {
      instructions.push(`### ${tool.name}`);
      instructions.push(`${tool.description}`);
      if (tool.capabilities && tool.capabilities.length > 0) {
        instructions.push(`Capabilities: ${tool.capabilities.join(", ")}`);
      }
      instructions.push("");
    });
  }

  instructions.push(`## Setup Requirements`);
  if (server.package) {
    instructions.push(`- Install package: \`${server.package}\``);
  }
  if (server.configTemplate?.auth?.token_env) {
    instructions.push(`- Set environment variable: \`${server.configTemplate.auth.token_env}\``);
  }
  if (server.configTemplate?.env) {
    instructions.push(`- Configure environment variables:`);
    Object.entries(server.configTemplate.env).forEach(([key, value]) => {
      instructions.push(`  - \`${key}=${value}\``);
    });
  }

  if (server.documentation) {
    instructions.push(`\n## Documentation`);
    instructions.push(`For more details, see: ${server.documentation}`);
  }

  return instructions.join("\n");
}
