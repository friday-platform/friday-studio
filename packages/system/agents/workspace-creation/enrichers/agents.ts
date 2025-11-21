import type { AtlasAgentConfig } from "@atlas/agent-sdk";
import { repairJson } from "@atlas/agent-sdk";
import { bundledAgents } from "@atlas/bundled-agents";
import type { LLMAgentConfig } from "@atlas/config";
import {
  extractKeywordsFromNeed,
  mapNeedToMCPServers,
  matchBundledAgents,
} from "@atlas/core/mcp-registry/deterministic-matching";
import { getDefaultProviderOpts, registry } from "@atlas/llm";
import { logger } from "@atlas/logger";
import { generateObject } from "ai";
import { z } from "zod";

type AgentArchetype =
  | "collector"
  | "reader"
  | "analyzer"
  | "evaluator"
  | "reporter"
  | "notifier"
  | "executor";

const MODEL_CONFIGS_BY_ARCHETYPE: Record<
  AgentArchetype,
  { model: string; temperature: number; maxTokens: number }
> = {
  collector: { model: "claude-haiku-4-5", temperature: 0.1, maxTokens: 4000 },
  reader: { model: "claude-haiku-4-5", temperature: 0.1, maxTokens: 8000 },
  analyzer: { model: "claude-sonnet-4-5", temperature: 0.3, maxTokens: 8000 },
  evaluator: { model: "claude-sonnet-4-5", temperature: 0.2, maxTokens: 6000 },
  reporter: { model: "claude-haiku-4-5", temperature: 0.2, maxTokens: 6000 },
  notifier: { model: "claude-haiku-4-5", temperature: 0.1, maxTokens: 3000 },
  executor: { model: "claude-sonnet-4-5", temperature: 0.1, maxTokens: 8000 },
};

/**
 * Determines agent archetype based on needs and description using LLM.
 * Maps agent intent to appropriate model configurations.
 */
async function determineArchetype(needs: string[], description: string): Promise<AgentArchetype> {
  const result = await generateObject({
    model: registry.languageModel("anthropic:claude-haiku-4-5"),
    messages: [
      {
        role: "system",
        content: `You determine the appropriate agent archetype based on needs and description.

Archetypes:
- collector: Retrieves data from external APIs (Slack, GitHub, web scraping)
- reader: Extracts content from files (PDFs, docs, CSVs, parsing structured data)
- analyzer: Performs analysis and reasoning on data (trends, patterns, insights)
- evaluator: Makes decisions and recommendations (scoring, ranking, approval)
- reporter: Generates structured reports and summaries (documentation, formatting)
- notifier: Sends output to external services (email, Slack, webhooks)
- executor: Performs system operations (file cleanup, command execution, maintenance)

Select the archetype that best matches the agent's PRIMARY function.`,
        providerOptions: getDefaultProviderOpts("anthropic"),
      },
      {
        role: "user",
        content: `Agent description: ${description}

Capabilities needed: ${needs.join(", ")}

What archetype best fits this agent?`,
      },
    ],
    schema: z.object({
      archetype: z.enum([
        "collector",
        "reader",
        "analyzer",
        "evaluator",
        "reporter",
        "notifier",
        "executor",
      ]),
      reasoning: z.string().describe("Brief explanation of archetype choice"),
    }),
    temperature: 0.2,
    maxRetries: 3,
    experimental_repairText: repairJson,
  });

  logger.debug("AI SDK generateObject completed", {
    agent: "agent-enricher",
    step: "determine-archetype",
    usage: result.usage,
  });

  return result.object.archetype;
}

/**
 * Generates a simple prompt for an agent based on its description and configuration.
 * Used for both bundled and LLM agents.
 *
 * Deterministically appends configuration as a structured block at the end of the prompt.
 */
function generateAgentPrompt(agent: {
  name: string;
  description: string;
  configuration?: Record<string, unknown>;
}): string {
  let prompt = agent.description;

  if (agent.configuration && Object.keys(agent.configuration).length > 0) {
    prompt += "\n\nConfiguration:";
    for (const [key, value] of Object.entries(agent.configuration)) {
      // Serialize value based on type
      const serializedValue =
        typeof value === "string"
          ? value
          : Array.isArray(value)
            ? value.join(", ")
            : JSON.stringify(value);
      prompt += `\n- ${key}: ${serializedValue}`;
    }
  }

  return prompt;
}

/**
 * Enriches agent with configuration using deterministic matching.
 * Uses LLM only for archetype determination when creating LLM agents.
 */
async function enrichAgent(agent: {
  id: string;
  name: string;
  description: string;
  needs: string[];
  configuration?: Record<string, unknown>;
}): Promise<{ id: string; config: AtlasAgentConfig | LLMAgentConfig }> {
  // Extract keywords from verbose needs (e.g., "Slack API access" → ["slack"])
  const keywords = agent.needs.flatMap((need) => extractKeywordsFromNeed(need));

  // Try deterministic bundled agent match using extracted keywords
  const bundledMatches = matchBundledAgents(keywords);

  if (bundledMatches.length === 1) {
    // Single bundled agent match - use it
    const match = bundledMatches[0];

    if (!match) {
      throw new Error("Unexpected: bundledMatches[0] is undefined");
    }

    const bundledAgent = bundledAgents.find((a) => a.metadata.id === match.agentId);

    if (!bundledAgent) {
      throw new Error(`Bundled agent ${match.agentId} not found`);
    }

    const config: AtlasAgentConfig = {
      type: "atlas",
      agent: match.agentId,
      description: agent.description,
      prompt: generateAgentPrompt(agent),
      env: bundledAgent.environmentConfig?.required
        ? Object.fromEntries(
            bundledAgent.environmentConfig.required.map((envVar) => [envVar.name, "auto"]),
          )
        : undefined,
    };

    return { id: agent.id, config };
  }

  // Multiple bundled matches - plan validation error
  if (bundledMatches.length > 1) {
    const matchedNames = bundledMatches.map((m) => m.name).join(", ");
    throw new Error(
      `Invalid plan: Agent "${agent.name}" has ambiguous needs [${agent.needs.join(", ")}] that match multiple bundled agents: ${matchedNames}. ` +
        `The workspace planner must generate more specific needs or split this into separate agents.`,
    );
  }

  // No bundled matches - use LLM agent
  const archetype = await determineArchetype(agent.needs, agent.description);
  const archetypeConfig = MODEL_CONFIGS_BY_ARCHETYPE[archetype];

  const config: LLMAgentConfig = {
    type: "llm",
    description: agent.description,
    config: {
      provider: "anthropic",
      model: archetypeConfig.model,
      prompt: generateAgentPrompt(agent),
      temperature: archetypeConfig.temperature,
      max_tokens: archetypeConfig.maxTokens,
      max_retries: 3,
      timeout: "5m",
    },
  };

  return { id: agent.id, config };
}

/**
 * Enriches agents with configurations and extracts MCP domains needed for LLM agents.
 * Uses deterministic matching to find MCP servers based on agent needs.
 */
export async function enrichAgentsWithDomains(
  agents: Array<{
    id: string;
    name: string;
    description: string;
    needs: string[];
    configuration?: Record<string, unknown>;
  }>,
): Promise<{
  enrichedAgents: Array<{ id: string; config: AtlasAgentConfig | LLMAgentConfig }>;
  mcpDomains: string[];
}> {
  const enrichedAgents = await Promise.all(agents.map((agent) => enrichAgent(agent)));

  // Bundled agents manage their own MCP connections; only LLM agents need workspace-level MCP servers
  const mcpDomainsSet = new Set<string>();

  for (const [index, agent] of agents.entries()) {
    const enrichedAgent = enrichedAgents[index];

    if (enrichedAgent?.config.type === "llm") {
      // Extract keywords from verbose needs and find MCP servers
      const keywords = agent.needs.flatMap((need) => extractKeywordsFromNeed(need));

      for (const keyword of keywords) {
        const mcpMatches = mapNeedToMCPServers(keyword);
        for (const match of mcpMatches) {
          // Add all matched domains from this MCP server
          for (const domain of match.matchedDomains) {
            mcpDomainsSet.add(domain);
          }
        }
      }
    }
  }

  return { enrichedAgents, mcpDomains: Array.from(mcpDomainsSet) };
}
