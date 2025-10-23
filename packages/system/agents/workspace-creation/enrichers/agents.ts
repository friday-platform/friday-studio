import type { AtlasAgentConfig } from "@atlas/agent-sdk";
import { bundledAgents } from "@atlas/bundled-agents";
import type { LLMAgentConfig } from "@atlas/config";
import { anthropic } from "@atlas/core";
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
  collector: { model: "claude-4-5-haiku", temperature: 0.1, maxTokens: 4000 },
  reader: { model: "claude-4-5-haiku", temperature: 0.1, maxTokens: 8000 },
  analyzer: { model: "claude-3-7-sonnet-latest", temperature: 0.3, maxTokens: 8000 },
  evaluator: { model: "claude-3-7-sonnet-latest", temperature: 0.2, maxTokens: 6000 },
  reporter: { model: "claude-3-5-haiku-latest", temperature: 0.2, maxTokens: 6000 },
  notifier: { model: "claude-3-5-haiku-latest", temperature: 0.1, maxTokens: 3000 },
  executor: { model: "claude-3-7-sonnet-latest", temperature: 0.1, maxTokens: 8000 },
};

const BundledAgentSpecSchema = z.object({
  source: z.literal("bundled"),
  bundledId: z.string().describe("ID of the bundled agent to use"),
  prompt: z.string().describe("Brief prompt (3-5 lines) for the agent"),
});

const GeneratedAgentSpecSchema = z.object({
  source: z.literal("generated"),
  archetype: z
    .enum(["collector", "reader", "analyzer", "evaluator", "reporter", "notifier", "executor"])
    .describe("Archetype determining model and config"),
  prompt: z.string().describe("Brief prompt (3-5 lines) for the agent"),
  mcpDomains: z.array(z.string()).describe("MCP domains this specific agent needs"),
});

const AgentSpecSchema = z.union([BundledAgentSpecSchema, GeneratedAgentSpecSchema]);

const AgentEnricherSchema = z.object({ result: AgentSpecSchema });

function getSystemPrompt(): string {
  return `<role>
You determine agent implementation strategy and generate configuration.
</role>

<context>
You receive an agent specification with:
- id: Kebab-case identifier
- name: Human-readable name
- description: What the agent does
- needs: Capabilities required
- configuration: Optional user-specific config values

Your task is to decide whether to use a bundled agent or generate a new LLM agent.
</context>

<bundled_agents>
${bundledAgents
  .map(({ metadata }) => {
    const examples = metadata.expertise.examples?.length
      ? `\n  Examples: ${metadata.expertise.examples
          .slice(0, 3)
          .map((e) => `"${e}"`)
          .join(", ")}`
      : "";
    return `${metadata.id}: ${metadata.displayName} - ${metadata.description} (domains: ${metadata.expertise.domains.join(", ")})${examples}`;
  })
  .join("\n")}
---
Research and web scraping tasks should be handled by the 'research' agent.
</bundled_agents>

<archetypes>
- collector: Retrieves data from external APIs (Slack, GitHub, web)
- reader: Extracts content from files (PDFs, docs, CSVs)
- analyzer: Performs analysis and reasoning on data
- evaluator: Makes decisions and recommendations
- reporter: Generates structured reports and summaries
- notifier: Sends output to external services
- executor: Performs system operations (file cleanup, command execution, maintenance tasks)
</archetypes>

<instructions>
1. Check if a bundled agent matches by comparing descriptions, examples, and domains
2. PREFER bundled agents when there's a reasonable match
3. If bundled: Return bundled agent ID and generate appropriate prompt
4. If generated: Select archetype, generate prompt, identify MCP domains
5. For generated agents ONLY: Identify MCP domains if the agent needs external tools

CRITICAL ANTI-HALLUCINATION RULE:
If the agent description mentions researching PEOPLE, COMPANIES, or PROFESSIONAL BACKGROUNDS, you MUST use the bundled 'research' agent, even if the description includes other tasks (like email, analysis, etc.). The research agent has built-in citation and verification to prevent hallucinating facts about people.

Examples triggering research agent:
- "researches each prospect and their company" → MUST use research agent
- "research founding teams" → MUST use research agent
- "gather company intelligence and founder backgrounds" → MUST use research agent

CRITICAL MCP DOMAIN RULES:
- DO NOT add MCP domains for file system operations (provided automatically)
- DO NOT add MCP domains for email tasks (provided automatically)
- ONLY add MCP domains for explicit external services (Slack, GitHub, Stripe, etc.)
</instructions>

<prompt_guidelines>
Write brief 3-5 line prompts that specify:
- The agent's responsibility and expertise
- Key task to perform
- Input data format and source (if applicable)
- Expected output format or action
- CRITICAL: Include specific destinations from configuration (Slack channels, email addresses, webhooks)
Keep it direct and actionable.

For Slack agents: ALWAYS include the channel name if provided (e.g., "Post to #team-updates")
</prompt_guidelines>`;
}

async function enrichAgent(
  agent: {
    id: string;
    name: string;
    description: string;
    needs: string[];
    configuration?: Record<string, unknown>;
  },
  abortSignal?: AbortSignal,
): Promise<{ id: string; config: AtlasAgentConfig | LLMAgentConfig }> {
  const { object } = await generateObject({
    model: anthropic("claude-sonnet-4-20250514"),
    schema: AgentEnricherSchema,
    system: getSystemPrompt(),
    prompt: `Determine implementation for this agent:

ID: ${agent.id}
Name: ${agent.name}
Description: ${agent.description}
Needs: ${agent.needs.join(", ")}
${agent.configuration ? `Configuration: ${JSON.stringify(agent.configuration, null, 2)}` : ""}

Decide: bundled or generated?
If bundled: Specify bundledId and prompt
If generated: Specify archetype, prompt, and mcpDomains (only if external tools needed)`,
    temperature: 0.2,
    maxRetries: 3,
    abortSignal,
  });

  const spec = object.result;

  if (spec.source === "bundled") {
    const bundledAgent = bundledAgents.find((a) => a.metadata.id === spec.bundledId);
    if (!bundledAgent) {
      throw new Error(`Bundled agent ${spec.bundledId} not found`);
    }

    const config: AtlasAgentConfig = {
      type: "atlas",
      agent: spec.bundledId,
      description: agent.description,
      prompt: spec.prompt,
      env: bundledAgent.environmentConfig?.required
        ? Object.fromEntries(
            bundledAgent.environmentConfig.required.map((envVar) => [envVar.name, "auto"]),
          )
        : undefined,
    };

    return { id: agent.id, config };
  }

  const archetypeConfig = MODEL_CONFIGS_BY_ARCHETYPE[spec.archetype];
  const config: LLMAgentConfig = {
    type: "llm",
    description: agent.description,
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

  return { id: agent.id, config };
}

export async function enrichAgentsWithDomains(
  agents: Array<{
    id: string;
    name: string;
    description: string;
    needs: string[];
    configuration?: Record<string, unknown>;
  }>,
  abortSignal?: AbortSignal,
): Promise<{
  enrichedAgents: Array<{ id: string; config: AtlasAgentConfig | LLMAgentConfig }>;
  mcpDomains: string[];
}> {
  const enrichedAgents = await Promise.all(agents.map((agent) => enrichAgent(agent, abortSignal)));

  // Bundled agents manage their own MCP connections; only LLM agents need workspace-level MCP servers
  const mcpDomains: string[] = [];
  for (const [index, agent] of agents.entries()) {
    const enrichedAgent = enrichedAgents[index];

    if (enrichedAgent?.config.type === "llm") {
      const { object } = await generateObject({
        model: anthropic("claude-3-5-haiku-latest"),
        schema: z.object({
          result: z.object({
            mcpDomains: z.array(z.string()).describe("MCP server domains needed for this agent"),
          }),
        }),
        system: `Extract MCP server domains from agent capabilities.

Available MCP servers:
${Object.values(bundledAgents)
  .map((a) => `${a.metadata.id}: ${a.metadata.expertise.domains.join(", ")}`)
  .join("\n")}

The Altas platform automatically provides tools to agents for email and filesystem access. DO NOT return MCP servers for these domains.

Return domain names matching available MCP servers.`,
        prompt: `Agent capabilities: ${agent.needs.join(", ")}

Return MCP server domains needed (e.g., ["slack"], ["github"]).`,
        temperature: 0.1,
        maxRetries: 3,
        abortSignal,
      });

      mcpDomains.push(...object.result.mcpDomains);
    }
  }

  return { enrichedAgents, mcpDomains };
}
