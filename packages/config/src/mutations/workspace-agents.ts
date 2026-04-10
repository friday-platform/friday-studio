/**
 * Workspace-level agent extraction from workspace configuration.
 *
 * Extracts top-level agents defined in the `agents` section of workspace.yml.
 * These are distinct from FSM-embedded step agents — they represent workspace-level
 * agent identity with their own prompts, descriptions, and env vars.
 */

import type { WorkspaceAgentConfig } from "../agents.ts";
import type { WorkspaceConfig } from "../workspace.ts";

// ==============================================================================
// WORKSPACE AGENT RESPONSE TYPE
// ==============================================================================

/**
 * Workspace-level agent for API/UI rendering.
 * Extracted from the top-level `agents` section of workspace config.
 */
export interface WorkspaceAgent {
  /** Agent key from config (e.g. "repo-cloner") */
  id: string;
  /** Display name — same as id, the config key */
  name: string;
  /** Agent purpose/description */
  description: string;
  /** Agent type discriminator ("atlas" | "llm" | "system") */
  type: string;
  /** Agent identifier for atlas/system types (e.g. "claude-code") */
  agent: string | undefined;
  /** Agent prompt */
  prompt: string | undefined;
  /** Environment variables configured for this agent */
  env: Record<string, unknown>;
  /** LLM inference provider (e.g. "anthropic") */
  provider: string | undefined;
  /** LLM model identifier (e.g. "claude-sonnet-4-6") */
  model: string | undefined;
  /** LLM temperature */
  temperature: number | undefined;
  /** Available tools (MCP server names) */
  tools: string[] | undefined;
  /** Maximum output tokens */
  maxTokens: number | undefined;
  /** Tool choice strategy ("auto" | "required" | "none") */
  toolChoice: string | undefined;
  /** Request timeout duration */
  timeout: string | undefined;
  /** Maximum retry count */
  maxRetries: number | undefined;
  /** Provider-specific options */
  providerOptions: Record<string, unknown> | undefined;
}

// ==============================================================================
// INTERNAL HELPERS
// ==============================================================================

/**
 * Extract prompt from a typed agent config using discriminated union narrowing.
 */
function extractPrompt(agentConfig: WorkspaceAgentConfig): string | undefined {
  switch (agentConfig.type) {
    case "atlas":
      return agentConfig.prompt;
    case "llm":
      return agentConfig.config.prompt;
    case "system":
      return agentConfig.config?.prompt;
  }
}

/**
 * Extract agent identifier from a typed agent config.
 * Atlas and system agents have an `agent` field; LLM agents do not.
 */
function extractAgentId(agentConfig: WorkspaceAgentConfig): string | undefined {
  switch (agentConfig.type) {
    case "atlas":
      return agentConfig.agent;
    case "system":
      return agentConfig.agent;
    case "llm":
      return undefined;
  }
}

/**
 * Extract env vars from a typed agent config.
 * Atlas and user agents have top-level env.
 */
function extractEnv(agentConfig: WorkspaceAgentConfig): Record<string, unknown> {
  if (agentConfig.type === "atlas" || agentConfig.type === "user") {
    return agentConfig.env ?? {};
  }
  return {};
}

/** LLM-specific fields extracted from agent config. */
interface LLMConfigFields {
  provider: string | undefined;
  model: string | undefined;
  temperature: number | undefined;
  tools: string[] | undefined;
  maxTokens: number | undefined;
  toolChoice: string | undefined;
  timeout: string | undefined;
  maxRetries: number | undefined;
  providerOptions: Record<string, unknown> | undefined;
}

/**
 * Extract LLM configuration fields from a typed agent config.
 * Only LLM agents have these fields; atlas and system agents return all undefined.
 */
function extractLLMConfig(agentConfig: WorkspaceAgentConfig): LLMConfigFields {
  if (agentConfig.type !== "llm") {
    return {
      provider: undefined,
      model: undefined,
      temperature: undefined,
      tools: undefined,
      maxTokens: undefined,
      toolChoice: undefined,
      timeout: undefined,
      maxRetries: undefined,
      providerOptions: undefined,
    };
  }

  const { config } = agentConfig;
  return {
    provider: config.provider,
    model: config.model,
    temperature: config.temperature,
    tools: config.tools,
    maxTokens: config.max_tokens,
    toolChoice: config.tool_choice,
    timeout: config.timeout,
    maxRetries: config.max_retries,
    providerOptions: config.provider_options,
  };
}

// ==============================================================================
// EXTRACTION
// ==============================================================================

/**
 * Extract top-level workspace agents from workspace config.
 * Returns an array of agent definitions suitable for rendering agent cards.
 *
 * @param config - Workspace configuration
 * @returns Array of workspace agent definitions
 */
export function deriveWorkspaceAgents(config: WorkspaceConfig): WorkspaceAgent[] {
  if (!config.agents) return [];

  const agents: WorkspaceAgent[] = [];

  for (const [id, agentConfig] of Object.entries(config.agents)) {
    agents.push({
      id,
      name: id,
      description: agentConfig.description,
      type: agentConfig.type,
      agent: extractAgentId(agentConfig),
      prompt: extractPrompt(agentConfig),
      env: extractEnv(agentConfig),
      ...extractLLMConfig(agentConfig),
    });
  }

  return agents;
}
