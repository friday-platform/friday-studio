import type { MCPDiscoveryRequest, MCPServerMetadata } from "@atlas/core";
import { MCPRegistry } from "@atlas/core";
import { tool } from "ai";
import { z } from "zod/v4";

/**
 * MCP Discovery Tool for Atlas Workspace Creation Flow
 *
 * Uses three-tier discovery strategy:
 * - Tier 1: Agent-based discovery from existing agent configurations
 * - Tier 2: Static registry of curated production-ready servers
 * - Tier 3: Web research discovery
 */
export const mcpDiscoveryTool = tool({
  description:
    "Discover the best MCP server for workspace capabilities using intelligent three-tier search",
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
        "Specific capabilities required, e.g., ['repository-management', 'issue-tracking']",
      ),
  }),
  execute: async ({ intent, domain, capabilities }) => {
    try {
      const registry = await MCPRegistry.getInstance();
      const request: MCPDiscoveryRequest = { intent, domain, capabilities };

      // Perform three-tier discovery
      const bestMatch = await registry.discoverBestMCPServer(request);

      if (!bestMatch) {
        return {
          success: false,
          message: `No suitable MCP server found for "${intent}"`,
          suggestions: [
            "Try a more specific or different description of your requirements",
            "Consider breaking down complex requirements into smaller, more focused needs",
            "Check if your requirements can be met with Atlas built-in tools",
          ],
        };
      }

      // Generate MCP configuration for workspace.yml
      const configuration = generateMCPConfiguration(bestMatch.server);

      return {
        success: true,
        server: {
          id: bestMatch.server.id,
          description: bestMatch.server.description,
          category: bestMatch.server.category,
          securityRating: bestMatch.server.securityRating,
          package: bestMatch.server.package,
          documentation: bestMatch.server.documentation,
        },
        confidence: bestMatch.confidence,
        reasoning: bestMatch.reasoning,
        source: bestMatch.source,
        configuration,
        useCases: bestMatch.server.useCases,
        availableTools: bestMatch.server.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          capabilities: tool.capabilities,
        })),
        integrationInstructions: generateIntegrationInstructions(bestMatch.server),
      };
    } catch (error) {
      return {
        success: false,
        error: `MCP discovery failed: ${error instanceof Error ? error.message : String(error)}`,
        message:
          "An error occurred during MCP server discovery. Please try again or contact support if the issue persists.",
      };
    }
  },
});

/**
 * Generate MCP configuration for workspace.yml
 */
function generateMCPConfiguration(server: MCPServerMetadata) {
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
 * Generate integration instructions for the discovered server
 */
function generateIntegrationInstructions(server: MCPServerMetadata) {
  const instructions = [`# ${server.name} Integration\n`];

  instructions.push(`**Description**: ${server.description}\n`);
  instructions.push(`**Security Rating**: ${server.securityRating}\n`);
  instructions.push(`**Package**: ${server.package || "N/A"}\n`);

  if (server.configTemplate.auth && server.configTemplate.auth.token_env) {
    instructions.push(`\n## Setup Instructions\n`);
    instructions.push(
      `1. Set up authentication by configuring the \`${server.configTemplate.auth.token_env}\` environment variable\n`,
    );
    instructions.push(`2. Ensure you have the necessary permissions and access for this service\n`);
  }

  if (server.configTemplate.transport.command === "npx") {
    instructions.push(`3. The server will be automatically installed via npx when first used\n`);
  } else if (server.configTemplate.transport.command === "uvx") {
    instructions.push(`3. The server will be automatically installed via uvx when first used\n`);
  }

  instructions.push(`\n## Available Tools\n`);
  instructions.push(
    server.tools.map((tool: any) => `- **${tool.name}**: ${tool.description}`).join("\n"),
  );

  instructions.push(`\n## Use Cases\n`);
  instructions.push(server.useCases.map((useCase: string) => `- ${useCase}`).join("\n"));

  if (server.documentation) {
    instructions.push(`\n## Documentation\n`);
    instructions.push(`For detailed information, see: ${server.documentation}\n`);
  }

  return instructions.join("");
}
