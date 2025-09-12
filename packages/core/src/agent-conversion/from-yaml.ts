/**
 * YAML to SDK Agent Conversion
 *
 * Converts .agent.yml files into AtlasAgent instances. Handles LLM
 * provider setup, tool filtering, and environment validation.
 */

import type {
  AtlasAgent,
  AtlasTool,
  AtlasTools,
  AtlasUIMessage,
  ToolCall,
  ToolResult,
} from "@atlas/agent-sdk";
import { createAgent } from "@atlas/agent-sdk";
import { pipeUIMessageStream } from "@atlas/agent-sdk/vercel-helpers";
import { stepCountIs, streamText } from "ai";
import { registry, validateProviderConfig } from "../llm-provider-registry/index.ts";
import { extractToolAllowlist, extractToolDenylist } from "./yaml/parser.ts";
import type { YAMLAgentDefinition } from "./yaml/schema.ts";

export type YamlAgentResult = {
  response: string;
  reasoning?: string;
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
};
export type YamlAgent = AtlasAgent<YamlAgentResult>;

/**
 * Convert parsed YAML definition to AtlasAgent.
 * Applies tool filtering and environment validation from .agent.yml files.
 */
export function convertYAMLToAgent(yaml: YAMLAgentDefinition): YamlAgent {
  // Environment validation is handled during YAML parsing in parseYAMLAgentContent

  const llmConfig = yaml.llm;
  const maxRetries = 3; // Enable retries for API resilience (e.g., 529 errors)

  validateProviderConfig(llmConfig.provider);
  const model = registry.languageModel(`${llmConfig.provider}:${llmConfig.model}`);

  return createAgent({
    id: yaml.agent.id,
    displayName: yaml.agent.displayName,
    version: yaml.agent.version,
    description: yaml.agent.description,
    expertise: yaml.agent.expertise,
    handler: async (prompt, { stream, tools }) => {
      const allTools = filterTools(tools, extractToolAllowlist(yaml), extractToolDenylist(yaml));

      const result = streamText({
        model,
        system: llmConfig.prompt,
        messages: [{ role: "user" as const, content: prompt }],
        tools: allTools,
        toolChoice: llmConfig.tool_choice || "auto",
        temperature: llmConfig.temperature,
        maxOutputTokens: llmConfig.max_tokens,
        maxRetries,
        stopWhen: stepCountIs(llmConfig.max_steps || 10),
        ...(llmConfig.provider_options || {}),
      });

      pipeUIMessageStream(result.toUIMessageStream<AtlasUIMessage>(), stream);

      const [text, reasoning, toolCalls, toolResults] = await Promise.all([
        result.text,
        result.reasoningText,
        result.toolCalls,
        result.toolResults,
      ]);

      return { reasoning, response: text, toolCalls, toolResults };
    },
    environment: yaml.environment,
    mcp: yaml.mcp_servers,
  });
}

/**
 * Collect MCP tools and apply YAML-defined allow/deny filters.
 * @FIXME: MCP_TOOL_FILTERING tool filtering should be encapsulated in @atlas/mcp.
 */
function filterTools(
  tools: AtlasTools,
  allowlists: Record<string, string[]>,
  denylists: Record<string, string[]>,
): Record<string, AtlasTool> {
  const filtered: Record<string, AtlasTool> = {};

  for (const [toolName, tool] of Object.entries(tools)) {
    let shouldInclude = true;
    for (const allowlist of Object.values(allowlists)) {
      if (allowlist.length > 0 && !allowlist.includes(toolName)) {
        shouldInclude = false;
        break;
      }
    }

    for (const denylist of Object.values(denylists)) {
      if (denylist.includes(toolName)) {
        shouldInclude = false;
        break;
      }
    }

    if (shouldInclude) {
      filtered[toolName] = tool;
    }
  }

  return filtered;
}
