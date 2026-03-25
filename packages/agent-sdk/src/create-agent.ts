import { z } from "zod";
import type { AgentPayload } from "./result.ts";
import { err } from "./result.ts";
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
import { stringifyError } from "./utils.ts";

class AtlasAgentImpl<TInput = string, TOutput = unknown> implements AtlasAgent<TInput, TOutput> {
  metadata: AgentMetadata;
  private handler: AgentHandler<TInput, TOutput>;
  private environment?: AgentEnvironmentConfig;
  private mcp?: Record<string, AgentMCPServerConfig>;
  private llm?: AgentLLMConfig;
  private _useWorkspaceSkills: boolean;

  constructor(config: CreateAgentConfig<TInput, TOutput>) {
    this.metadata = {
      id: config.id,
      displayName: config.displayName,
      version: config.version,
      description: config.description,
      summary: config.summary,
      constraints: config.constraints,
      expertise: config.expertise,
      inputSchema: config.inputSchema,
      outputSchema: config.outputSchema,
    };

    this.handler = config.handler;
    this.environment = config.environment;
    this.mcp = config.mcp;
    this.llm = config.llm;
    this._useWorkspaceSkills = config.useWorkspaceSkills ?? false;
    this.validateConfig();
  }

  private validateConfig(): void {
    const metadataResult = AgentMetadataSchema.safeParse(this.metadata);
    if (!metadataResult.success) {
      throw new Error(z.prettifyError(metadataResult.error));
    }

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

  async execute(input: TInput, context: AgentContext): Promise<AgentPayload<TOutput>> {
    try {
      return await this.handler(input, context);
    } catch (error) {
      // AbortError must propagate for cancellation to work
      if (error instanceof DOMException && error.name === "AbortError") {
        throw error;
      }
      // Execution layer wraps with metadata (agentId, timestamp, etc)
      return err(stringifyError(error));
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

  get useWorkspaceSkills(): boolean {
    return this._useWorkspaceSkills;
  }
}

/**
 * Creates a domain expert agent with typed input/output.
 *
 * @example
 * ```typescript
 * const plannerAgent = createAgent<string, PlannerResult>({
 *   id: "planner",
 *   displayName: "Planner",
 *   version: "1.0.0",
 *   description: "Plans workspaces",
 *   expertise: { examples: [] },
 *   handler: async (input, { logger }) => {
 *     if (!input) return err("No input provided");
 *     return ok({ planSummary: "...", artifactId: "..." });
 *   }
 * });
 * ```
 */
export function createAgent<TInput = string, TOutput = unknown>(
  config: CreateAgentConfig<TInput, TOutput>,
): AtlasAgent<TInput, TOutput> {
  return new AtlasAgentImpl<TInput, TOutput>(config);
}
