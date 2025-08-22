/**
 * Agent Conversion Layer
 *
 * Converts different agent formats (YAML files, workspace LLM configs) into
 * unified AtlasAgent instances. This bridges configuration formats with the
 * programmatic SDK, enabling Atlas to work with agents regardless of how
 * they're defined.
 */

import type { AtlasAgent } from "@atlas/agent-sdk";
import type { YAMLAgentDefinition } from "./yaml/schema.ts";
import type { LLMAgentConfig } from "@atlas/config";
import type { Logger } from "@atlas/logger";
import { convertYAMLToAgent } from "./from-yaml.ts";
import { convertLLMToAgent } from "./from-llm.ts";

/**
 * Convert parsed YAML definition to AtlasAgent.
 * Used during workspace initialization for .agent.yml files.
 */
export function convertYAMLAgentToSDK(definition: YAMLAgentDefinition): AtlasAgent {
  return convertYAMLToAgent(definition);
}

/**
 * Convert workspace LLM config to AtlasAgent.
 * Used at runtime for agents defined in workspace.yml.
 */
export function convertLLMAgentToSDK(
  config: LLMAgentConfig,
  agentId: string,
  logger: Logger,
): AtlasAgent {
  return convertLLMToAgent(config, agentId, logger);
}

export { convertYAMLToAgent } from "./from-yaml.ts";
export type { WrappedAgent, WrappedAgentResult } from "./from-llm.ts";
export type { YAMLAgentDefinition } from "./yaml/schema.ts";
export type { LLMAgentConfig } from "@atlas/config";
export { parseYAMLAgentContent } from "./yaml/parser.ts";
