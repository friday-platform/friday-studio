import { anthropic } from "@ai-sdk/anthropic";
import type { AtlasAgentConfig } from "@atlas/agent-sdk";
import { bundledAgents } from "@atlas/bundled-agents";
import type { LLMAgentConfig } from "@atlas/config";
import type { Logger } from "@atlas/logger";
import { stringifyError } from "@atlas/utils";
import { toKebabCase } from "@std/text";
import { generateObject, tool } from "ai";
import { z } from "zod/v4";
import type { WorkspaceBuilder } from "../builder.ts";

/**
 * Discriminated union type for tool execution results.
 * Success includes agent counts and details, failure includes error message.
 */
type ToolResult =
  | {
      success: true;
      agentIds: string[];
      mcpDomains: string[];
      text: string;
      totalAgents: number;
      bundledCount: number;
    }
  | { success: false; error: string };

/**
 * Agent archetypes classify agents based on their primary function in the system.
 * Each archetype has predefined model configurations for optimal performance.
 *
 * - collector: Retrieves data from external APIs (Slack, GitHub, web)
 * - reader: Extracts content from files (PDFs, docs, CSVs)
 * - analyzer: Performs analysis and reasoning on data
 * - evaluator: Makes decisions and recommendations
 * - reporter: Generates structured reports and summaries
 * - notifier: Sends output to external services
 */
type AgentArchetype =
  | "collector" // Retrieves data from external APIs
  | "reader" // Extracts content from files
  | "analyzer" // Performs analysis and reasoning
  | "evaluator" // Makes decisions and recommendations
  | "reporter" // Generates structured reports
  | "notifier" // Sends output to external services
  | "executor"; // Performs system operations and cleanup

// Default configurations for each archetype
const MODEL_CONFIGS_BY_ARCHETYPE: Record<
  AgentArchetype,
  { model: string; temperature: number; maxTokens: number }
> = {
  collector: { model: "claude-3-5-haiku-latest", temperature: 0.1, maxTokens: 4000 },
  reader: { model: "claude-3-5-haiku-latest", temperature: 0.1, maxTokens: 8000 },
  analyzer: { model: "claude-3-5-sonnet-20241022", temperature: 0.3, maxTokens: 8000 },
  evaluator: { model: "claude-3-5-sonnet-20241022", temperature: 0.2, maxTokens: 6000 },
  reporter: { model: "claude-3-5-haiku-latest", temperature: 0.2, maxTokens: 6000 },
  notifier: { model: "claude-3-5-haiku-latest", temperature: 0.1, maxTokens: 3000 },
  executor: { model: "claude-3-5-haiku-latest", temperature: 0.1, maxTokens: 3000 },
};

/**
 * Schema for specifying a bundled agent configuration.
 * Bundled agents are pre-built agents included with Atlas.
 */
const BundledAgentSpecSchema = z.object({
  source: z.literal("bundled"),
  bundledId: z.string().describe("ID of the bundled agent to use"),
  name: z.string().describe("Human-readable agent name"),
  prompt: z.string().describe("Brief prompt (3-5 lines) for the agent"),
  description: z.string().describe("Brief description of agent purpose"),
});

/**
 * Schema for specifying a generated LLM agent configuration.
 * Generated agents are created dynamically based on archetype patterns.
 */
const GeneratedAgentSpecSchema = z.object({
  source: z.literal("generated"),
  id: z.string().describe("Agent ID in kebab-case"),
  archetype: z
    .enum(["collector", "reader", "analyzer", "evaluator", "reporter", "notifier", "executor"])
    .describe("Archetype determining model and config"),
  name: z.string().describe("Human-readable agent name"),
  description: z.string().describe("Brief description of agent purpose"),
  prompt: z.string().describe("Brief prompt (3-5 lines) for the agent"),
  mcpDomains: z.array(z.string()).describe("MCP domains this specific agent needs"),
});

/**
 * Discriminated union schema for agent specifications.
 * Agents can be either bundled (pre-built) or generated (LLM-based).
 */
const AgentSpecSchema = z.discriminatedUnion("source", [
  BundledAgentSpecSchema,
  GeneratedAgentSpecSchema,
]);

/**
 * Schema for the batch agent generation response.
 * Contains all agent specifications.
 */
const BatchAgentResponseSchema = z.object({
  agents: z.array(AgentSpecSchema).describe("Array of agent specifications"),
});

/**
 * Creates a tool for generating agent configurations based on predefined archetypes.
 * Checks bundled agents first, then generates LLM agents as needed.
 *
 * @param builder - WorkspaceBuilder instance for adding agent configurations
 * @param logger - Logger instance for tracking operations
 * @param abortSignal - Optional signal to cancel the operation
 * @returns Tool that generates agent configurations from requirements
 */
export function getGenerateAgentsTool(
  builder: WorkspaceBuilder,
  logger: Logger,
  abortSignal?: AbortSignal,
) {
  return tool({
    description: "Generate all agent configurations in a single batch using archetypes",
    inputSchema: z.object({
      agentRequirements: z
        .array(z.string())
        .describe(
          "Array of agent requirement descriptions (e.g., 'reader: Extract meeting transcripts from uploaded files')",
        ),
    }),
    execute: async ({ agentRequirements }): Promise<ToolResult> => {
      logger.info("Batch generating agents with archetype approach", {
        count: agentRequirements.length,
      });

      // Build bundled agents reference with examples
      const bundledAgentsReference = bundledAgents
        .map(({ metadata }) => {
          const examples = metadata.expertise.examples?.length
            ? `\n  Examples: ${metadata.expertise.examples
                .slice(0, 3)
                .map((e) => `"${e}"`)
                .join(", ")}`
            : "";
          return `${metadata.id}: ${metadata.displayName} - ${metadata.description} (domains: ${metadata.expertise.domains.join(", ")})${examples}`;
        })
        .join("\n");

      const systemPrompt = `<role>
You generate agent specifications from pre-decomposed requirements.
</role>

<context>
You are given an array of agent requirements that have already been decomposed into single responsibilities.
Each requirement describes ONE agent that does ONE thing.
</context>

<instructions>

For each agent requirement:
1. Parse the requirement to understand the agent's purpose
2. Check if a bundled agent matches by comparing, descriptions, examples, and domains
3. PREFER bundled agents when there's a reasonable match
4. Only generate new agents when no bundled agent fits
5. Select appropriate archetype if generating
6. For generated agents ONLY: Identify MCP domains if the agent needs external tools
</instructions>

<archetypes>
- collector: Retrieves data from external APIs (Slack, GitHub, web)
- reader: Extracts content from files (PDFs, docs, CSVs)
- analyzer: Performs analysis and reasoning on data
- evaluator: Makes decisions and recommendations
- reporter: Generates structured reports and summaries
- notifier: Sends output to external services
- executor: Performs system operations (file cleanup, command execution, maintenance tasks)
</archetypes>

<bundled_agents>
${bundledAgentsReference}
---
Research and web scraping tasks should be handled by the 'research' agent.
</bundled_agents>

<prompt_guidelines>
Write brief 3-5 line prompts that specify:
- The agent's responsibility and expertise
- Key task to perform
- Input data format and source (if applicable)
- Expected output format or action
- CRITICAL: Include specific destinations (Slack channels, email addresses, webhooks)
Keep it direct and actionable.

For Slack agents: ALWAYS include the channel name if provided (e.g., "Post to #team-updates")
</prompt_guidelines>

<mcp_domain_guidelines>
ONLY add MCP domains for generated agents when they need explicit external tools.

DO NOT add MCP domains for:
- Reading from the file system (These tools are provided automatically to all agents)
- Email tasks (An email tool is provided automatically to all agents)
- Tasks that the agent can complete with just LLM reasoning
</mcp_domain_guidelines>`;

      try {
        // Single LLM call to generate all agents
        const { object } = await generateObject({
          model: anthropic("claude-sonnet-4-20250514"),
          schema: BatchAgentResponseSchema,
          system: systemPrompt,
          prompt: `Generate agent specifications for these pre-decomposed requirements:

${agentRequirements.map((req, i) => `${i + 1}. ${req}`).join("\n")}

For each requirement:
1. Infer a descriptive agent ID from the requirement
2. Check if a bundled agent matches (prefer bundled)
3. If bundled agent matches: Use it WITHOUT any MCP domains (bundled agents are self-contained)
4. If no match: Create generated agent with archetype, prompt, and ONLY necessary MCP domains


Each agent in the array should follow the discriminated union pattern with "source" field.`,
          temperature: 0.2,
          maxRetries: 3,
          maxOutputTokens: 12000,
          abortSignal,
        });

        logger.info("Generated agent specifications", {
          count: object.agents.length,
          bundled: object.agents.filter((a) => a.source === "bundled").length,
          generated: object.agents.filter((a) => a.source === "generated").length,
        });

        // Process each agent specification
        const agentConfigs: Array<{ id: string; config: AtlasAgentConfig | LLMAgentConfig }> = [];

        for (const spec of object.agents) {
          if (spec.source === "bundled") {
            // Use bundled agent
            const bundledAgent = bundledAgents.find((a) => a.metadata.id === spec.bundledId);
            if (!bundledAgent) {
              logger.warn(`Bundled agent ${spec.bundledId} not found, skipping`);
              continue;
            }

            const config: AtlasAgentConfig = {
              type: "atlas",
              agent: spec.bundledId,
              description: spec.description,
              prompt: spec.prompt,
              env: bundledAgent.environmentConfig?.required
                ? Object.fromEntries(
                    bundledAgent.environmentConfig.required.map((envVar) => [envVar.name, "auto"]),
                  )
                : undefined,
            };
            const agent = { id: spec.bundledId, config };
            logger.debug("Adding bundled agent to workspace", { agent });
            agentConfigs.push(agent);
          } else if (spec.source === "generated") {
            const agentId = toKebabCase(spec.id);
            // Generate LLM agent using archetype config
            const archetypeConfig = MODEL_CONFIGS_BY_ARCHETYPE[spec.archetype];

            const config: LLMAgentConfig = {
              type: "llm",
              description: spec.description,
              config: {
                provider: "anthropic",
                model: archetypeConfig.model,
                prompt: spec.prompt,
                temperature: archetypeConfig.temperature,
                max_tokens: archetypeConfig.maxTokens,
                max_retries: 3,
                timeout: "5m",
              },
            };
            const agent = { id: agentId, config };
            logger.debug("Adding LLM agent to workspace", { agent });
            agentConfigs.push(agent);
          }
        }

        // Add all agents to builder
        builder.addAgents(agentConfigs);

        // Collect MCP domains only from generated agents
        const mcpDomains = object.agents
          .filter((a) => a.source === "generated")
          .flatMap((a) => a.mcpDomains || []);

        // Add MCP domain requirements
        builder.addMCPDomainRequirements(mcpDomains);

        const bundledCount = object.agents.filter((a) => a.source === "bundled").length;
        const generatedCount = object.agents.filter((a) => a.source === "generated").length;

        return {
          success: true,
          agentIds: agentConfigs.map((a) => a.id),
          mcpDomains,
          text: `Successfully generated ${agentConfigs.length} agents (${bundledCount} bundled, ${generatedCount} generated)`,
          totalAgents: agentConfigs.length,
          bundledCount,
        };
      } catch (error) {
        logger.error("Failed to batch generate agents", { error });
        return { success: false, error: stringifyError(error) };
      }
    },
  });
}
