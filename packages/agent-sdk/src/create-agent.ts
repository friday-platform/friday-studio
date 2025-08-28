/**
 * Create Agent Function
 *
 * Main API for creating domain expert agents that interpret natural language
 * prompts and accomplish tasks within their expertise.
 */

import { z } from "zod/v4";
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
class AtlasAgentImpl<T = unknown> implements AtlasAgent<T> {
  metadata: AgentMetadata;
  private handler: AgentHandler;
  private environment?: AgentEnvironmentConfig;
  private mcp?: Record<string, AgentMCPServerConfig>;
  private llm?: AgentLLMConfig;

  constructor(config: CreateAgentConfig) {
    // Extract metadata from config
    this.metadata = {
      id: config.id,
      displayName: config.displayName,
      version: config.version,
      description: config.description,
      expertise: config.expertise,
      metadata: config.metadata,
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

  async execute(prompt: string, context: AgentContext): Promise<T> {
    try {
      // Execute the handler with the prompt and context
      return (await this.handler(prompt, context)) as T;
    } catch (error) {
      // Re-throw AwaitingSupervisorDecision exceptions
      if (error instanceof Error && error.name === "AwaitingSupervisorDecision") {
        throw error;
      }

      // Re-throw AbortError exceptions for proper cancellation handling
      if (error instanceof DOMException && error.name === "AbortError") {
        throw error;
      }

      // Wrap other errors with agent context
      throw new Error(
        `Agent ${this.metadata.id} execution failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
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
 * Create a domain expert agent with typed return values
 *
 * The generic type parameter T allows you to specify the exact return type
 * of your agent handler, enabling full type safety for agent results.
 * This is especially important for agents controlled by Atlas (like LLM agents)
 * where we need to ensure consistent return structures.
 *
 * @param T - The return type of the agent handler (defaults to unknown)
 *
 * @example
 * ```typescript
 * // Custom agent with typed return value
 * interface MyAgentResult {
 *   status: 'success' | 'error';
 *   data: unknown;
 * }
 *
 * export const githubAgent = createAgent<MyAgentResult>({
 *   id: "github",
 *   displayName: "GitHub Agent",
 *   version: "1.0.0",
 *   description: "GitHub domain expert for repository operations",
 *
 *   expertise: {
 *     domains: ["github", "vcs", "security"],
 *     capabilities: [
 *       "repository security scanning",
 *       "pull request review",
 *       "issue management"
 *     ],
 *     examples: [
 *       "scan my repository for vulnerabilities",
 *       "review PR #123 for code quality"
 *     ]
 *   },
 *
 *   handler: async (prompt, { tools, logger }) => {
 *     // Handler must return MyAgentResult type
 *     const { generateText } = await import('ai');
 *     const { anthropic } = await import('@ai-sdk/anthropic');
 *
 *     const result = await generateText({
 *       model: anthropic('claude-3-sonnet-20240229'),
 *       prompt,
 *       tools
 *     });
 *
 *     return {
 *       status: 'success' as const,
 *       data: result.text
 *     };
 *   }
 * });
 * ```
 */
export function createAgent<T = unknown>(config: CreateAgentConfig<T>): AtlasAgent<T> {
  return new AtlasAgentImpl<T>(config);
}
