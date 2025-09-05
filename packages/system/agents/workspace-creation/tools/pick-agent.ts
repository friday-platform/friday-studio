import { anthropic } from "@ai-sdk/anthropic";
import type { AtlasAgent, AtlasAgentConfig } from "@atlas/agent-sdk";
import { bundledAgents } from "@atlas/bundled-agents";
import { LLMAgentConfigSchema } from "@atlas/config";
import type { Logger } from "@atlas/logger";
import { toKebabCase } from "@std/text";
import { generateObject, generateText, tool } from "ai";
import { z } from "zod/v4";
import type { WorkspaceBuilder } from "../builder.ts";

function getBundledAgentPickerTool(
  builder: WorkspaceBuilder,
  logger: Logger,
  bundledAgents: AtlasAgent[],
) {
  return tool({
    description: "Select a bundled agent which meets requirements",
    inputSchema: z.object({
      id: z.string().meta({ description: "Bundled Agent ID" }),
      description: z
        .string()
        .meta({ description: "How the agent will be used to fulfill the requirements" }),
    }),
    execute: ({ id, description }) => {
      try {
        logger.info("Selected bundled agent", { id, description });
        const agent = bundledAgents.find((a) => a.metadata.id === id);
        if (!agent) {
          throw new Error(`Agent with id ${id} not found`);
        }
        const config: AtlasAgentConfig = {
          type: "atlas",
          agent: id,
          description,
          env: agent.environmentConfig?.required
            ? Object.fromEntries(agent.environmentConfig.required.map((key) => [key, ""]))
            : undefined,
        };

        logger.debug("Selected bundled agent configuration", { id, config });
        builder.addAgents([{ id, config }]);

        return { success: true, agentId: id, text: `Successfully selected bundled agent: ${id}` };
      } catch (error) {
        logger.error("Failed to select bundled agent", { id, error });
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
          text: `Failed to select bundled agent: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },
  });
}

function getLLMGeneratorTool(builder: WorkspaceBuilder, logger: Logger, abortSignal?: AbortSignal) {
  return tool({
    description: "Generate a LLM agent to meet requirements",
    inputSchema: z.object({ requirements: z.string() }),
    execute: async ({ requirements }) => {
      try {
        logger.info("Generating LLM agent", { requirements });
        const systemPrompt = `
        <identity>
          You build LLM agent configurations from requirements.
        </identity>
        <task>
          Generate configuration and prompts for LLM agents.
        </task>
        <instructions>
        1. Select model, temperature, tool call, and token limit for the agent.
        2. Write a prompt following the prompt_guidelines.
        3. Note tool requirements according to the tool_requirement_guidelines.
        </instructions>
        <tool_requirement_guidelines>
          These should map roughly to MCP Servers. Eg: (Slack, GitHub, Hubspot, filesystem, or PDF) Don't pick abstract concepts like 'ai' or 'forums'.
        </tool_requirement_guidelines>
        <prompt_guidelines>
          Start with a specific role:
          - "You are a [specific role + context]"
          - Bad: "You are a writer"
          - Good: "You are a technical writer at a SaaS company"

          Structure every prompt with XML tags:
          - <role>[Expert identity]</role>
          - <instructions>[Numbered steps]</instructions>
          - <output_format>[Exact format needed]</output_format>

          Write instructions as numbered steps:
          - One clear action per step
          - Order: input → processing → output
          - Reference tags: "Using the <data> content..."

          Define output explicitly:
          - Format: "Output as JSON/bullets/paragraphs"
          - Length: "Maximum 200 words"
          - Include/exclude: "Include only X, no Y"

          Give guidance on the voice and tone for all agents:
          - Communicate very directly, but in a friendly tone
          - No marketing or enterprise-speak. Remove buzzwords
          - Cut the fluff - focus on delivering maximum clarity in minimal words
          - DO NOT ADD EMOJIS TO THE OUTPUT

          Add examples only for complex tasks:
          <example>
            <input>[Sample]</input>
            <output>[Expected result]</output>
          </example>
        </prompt_guidelines>
        <output_format>
          Generate configuration to meet the required output schema.
          Generate prompts following the XML structure above. Keep under roughly 200 words.
        </output_format>
        <key_test>
          Could someone with no context complete this task exactly as intended?
        </key_test>
          `;
        const { object } = await generateObject({
          model: anthropic("claude-sonnet-4-20250514"),
          schema: z.object({
            name: z.string().meta({ description: "Human-readable agent name" }),
            description: z
              .string()
              .meta({ description: "How the agent will be used to fulfill the requirements" }),
            config: LLMAgentConfigSchema,
            tool_requirements: z
              .string()
              .array()
              .optional()
              .meta({
                description: "External domains which the agent needs tools for",
                examples: ["slack", "filesystem", "kubernetes", "pdf"],
              }),
          }),
          system: systemPrompt,
          prompt: `Create an LLM Agent configuration to meet the following requirements: ${requirements}`,
          maxOutputTokens: 10000,
          temperature: 0.3,
          maxRetries: 3,
          abortSignal,
        });

        logger.info("Generated LLM Agent configuration", { agentName: object.name });

        const agentId = toKebabCase(object.name);
        builder.addAgents([{ id: agentId, config: object.config }]);
        if (object.tool_requirements) {
          builder.addMCPDomainRequirements(object.tool_requirements);
        }

        return {
          success: true,
          agentId,
          agentName: object.name,
          text: `Successfully generated agent: ${object.name}`,
        };
      } catch (error) {
        logger.error("Failed to generate LLM agent", { requirements, error });
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
          text: `Failed to generate agent: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },
  });
}

export function getPickAgentTool(
  builder: WorkspaceBuilder,
  logger: Logger,
  abortSignal?: AbortSignal,
) {
  return tool({
    description: "Returns an agent configuration to meet given requirements",
    inputSchema: z.object({
      requirements: z.string().meta({ description: "Requirements for the agent. < 100 words." }),
      taskSummary: z
        .string()
        .meta({
          description: "Short (<5 words) summary of the current task",
          examples: ["Adding filesystem watcher agent", "Adding Slack agent"],
        }),
    }),
    execute: async ({ requirements }) => {
      /**
       * Specific tools for the Agent generator to use.
       */
      const pickBundledAgentTool = getBundledAgentPickerTool(builder, logger, bundledAgents);
      const llmGeneratorTool = getLLMGeneratorTool(builder, logger, abortSignal);

      logger.debug("Generating agents...");

      const systemPrompt = `
        <identity>
        You select or create agents based on requirements. You choose existing agents when possible, create new ones when needed.
        </identity>

        <instructions>
        1. Analyze the requirements to determine what the agent needs to do.
        2. Check bundled_agents. If one fits, call pick_bundled_agent with its ID.
        3. If no bundled agent fits, use llm_agent_generator to create a new one.
        </instructions>
        `;

      const { text } = await generateText({
        model: anthropic("claude-3-5-haiku-latest"),
        system: systemPrompt,
        prompt: `
        Select or create an agent to meet the following requirements: ${requirements}

        <bundled_agents>
        ${bundledAgents
          .map(
            ({ metadata }) => `${metadata.displayName}: ${metadata.description}\n
          ID: ${metadata.id}\n
          Expertise domains: ${metadata.expertise.domains}\n
          Example prompts: ${metadata.expertise.examples.join(", ")}\n`,
          )
          .join("\n")}
        </bundled_agents>
        `,
        temperature: 0.3,
        maxRetries: 3,
        toolChoice: "required",
        tools: { pick_bundled_agent: pickBundledAgentTool, llm_agent_generator: llmGeneratorTool },
        abortSignal,
      });

      return { text };
    },
  });
}
