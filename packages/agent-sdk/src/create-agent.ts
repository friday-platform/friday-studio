/**
 * Create Agent Function
 *
 * Main API for creating domain expert agents that interpret natural language
 * prompts and accomplish tasks within their expertise.
 */

import { stringifyError } from "@atlas/utils";
import { z } from "zod";
import type {
  AgentContext,
  AgentEnvironmentConfig,
  AgentHandler,
  AgentLLMConfig,
  AgentMCPServerConfig,
  AgentMetadata,
  AtlasAgent,
  CreateAgentConfig,
} from "./types.ts";
import {
  AgentEnvironmentConfigSchema,
  AgentLLMConfigSchema,
  AgentMetadataSchema,
  MCPServerConfigSchema,
} from "./types.ts";

/**
 * Internal implementation of AtlasAgent
 */
class AtlasAgentImpl<TInput = string, TOutput = unknown> implements AtlasAgent<TInput, TOutput> {
  metadata: AgentMetadata;
  private handler: AgentHandler<TInput, TOutput>;
  private environment?: AgentEnvironmentConfig;
  private mcp?: Record<string, AgentMCPServerConfig>;
  private llm?: AgentLLMConfig;

  constructor(config: CreateAgentConfig<TInput, TOutput>) {
    // Extract metadata from config
    this.metadata = {
      id: config.id,
      displayName: config.displayName,
      version: config.version,
      description: config.description,
      constraints: config.constraints,
      expertise: config.expertise,
      inputSchema: config.inputSchema,
    };

    this.handler = config.handler;
    this.environment = config.environment;
    this.mcp = config.mcp;
    this.llm = config.llm;

    // Validate configuration
    this.validateConfig();
  }

  private validateConfig(): void {
    // Validate metadata using Zod schema
    const metadataResult = AgentMetadataSchema.safeParse(this.metadata);
    if (!metadataResult.success) {
      throw new Error(z.prettifyError(metadataResult.error));
    }

    // Validate optional configurations if present
    if (this.environment) {
      const envResult = AgentEnvironmentConfigSchema.safeParse(this.environment);
      if (!envResult.success) {
        throw new Error(`Environment config error:\n${z.prettifyError(envResult.error)}`);
      }
    }

    if (this.mcp) {
      for (const [serverName, config] of Object.entries(this.mcp)) {
        const mcpResult = MCPServerConfigSchema.safeParse(config);
        if (!mcpResult.success) {
          throw new Error(
            `Invalid MCP server config for '${serverName}':\n${z.prettifyError(mcpResult.error)}`,
          );
        }
      }
    }

    if (this.llm) {
      const llmResult = AgentLLMConfigSchema.safeParse(this.llm);
      if (!llmResult.success) {
        throw new Error(`LLM config error:\n${z.prettifyError(llmResult.error)}`);
      }
    }
  }

  async execute(input: TInput, context: AgentContext): Promise<TOutput> {
    try {
      // Execute the handler with the input and context
      return await this.handler(input, context);
    } catch (error) {
      // Re-throw AbortError exceptions for proper cancellation handling
      if (error instanceof DOMException && error.name === "AbortError") {
        throw error;
      }

      // Re-throw other errors without wrapping - agent context is already in AgentResult
      // Wrapping here would create redundancy since orchestrator/callers already have agent metadata
      throw new Error(stringifyError(error));
    }
  }

  get environmentConfig(): AgentEnvironmentConfig | undefined {
    return this.environment;
  }

  get mcpConfig(): Record<string, AgentMCPServerConfig> | undefined {
    return this.mcp;
  }

  get llmConfig(): AgentLLMConfig | undefined {
    return this.llm;
  }
}

/**
 * Create a domain expert agent with typed input and output
 *
 * Generic type parameters allow specifying exact types for input and output.
 *
 * @param TInput - The input type (string by default, or structured via inputSchema)
 * @param TOutput - The output type (defaults to unknown)
 *
 * @example
 * ```typescript
 * // Agent with structured input
 * const plannerInput = z.object({
 *   intent: z.string(),
 *   artifactId: z.string().optional(),
 * });
 *
 * type PlannerInput = z.infer<typeof plannerInput>;
 *
 * interface PlannerResult {
 *   planSummary: string;
 *   artifactId: string;
 * }
 *
 * export const plannerAgent = createAgent<PlannerInput, PlannerResult>({
 *   id: "planner",
 *   displayName: "Planner",
 *   version: "1.0.0",
 *   description: "Plans workspaces",
 *   expertise: { domains: ["planning"], examples: [] },
 *   inputSchema: plannerInput,
 *   handler: async (input, { logger }) => {
 *     // input is typed as { intent: string; artifactId?: string }
 *     logger.info("Planning", { artifactId: input.artifactId });
 *     return { planSummary: "...", artifactId: "..." };
 *   }
 * });
 * ```
 */
export function createAgent<TInput = string, TOutput = unknown>(
  config: CreateAgentConfig<TInput, TOutput>,
): AtlasAgent<TInput, TOutput> {
  return new AtlasAgentImpl<TInput, TOutput>(config);
}
