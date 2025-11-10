import { APICallError } from "@ai-sdk/provider";
import type { ArtifactRef, AtlasAgent, AtlasTools, ToolCall, ToolResult } from "@atlas/agent-sdk";
import { createAgent } from "@atlas/agent-sdk";
import {
  collectToolUsageFromSteps,
  extractArtifactRefsFromToolResults,
} from "@atlas/agent-sdk/vercel-helpers";
import type { LLMAgentConfig } from "@atlas/config";
import type { Logger } from "@atlas/logger";
import { getTodaysDate } from "@atlas/utils";
import type { CoreSystemMessage, CoreUserMessage } from "ai";
import { stepCountIs, streamText } from "ai";
import { ANTHROPIC_CACHE_BREAKPOINT } from "../llm-provider.ts";
import { registry, validateProviderConfig } from "../llm-provider-registry/index.ts";
import { throwWithCause } from "../utils/error-helpers.ts";
import { filterWorkspaceAgentTools } from "./agent-tool-filters.ts";

export type WrappedAgentResult = {
  response: string;
  reasoning?: string;
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
  artifactRefs?: ArtifactRef[];
};
type WrappedAgent = AtlasAgent<string, WrappedAgentResult>;

// Tool usage collector moved to @atlas/agent-sdk/vercel-helpers

/**
 * Convert workspace LLM config to AtlasAgent.
 * Creates a runnable agent using workspace.yml LLM settings.
 */
export function convertLLMToAgent(
  config: LLMAgentConfig,
  agentId: string,
  logger: Logger,
): WrappedAgent {
  // Use configured retries or default to 3 for better resilience against 529 errors
  const maxRetries = config.config.max_retries ?? 3;

  validateProviderConfig(config.config.provider);
  const model = registry.languageModel(`${config.config.provider}:${config.config.model}`);

  // Store tools restriction for buildAgentContext to filter
  const allowedToolNames = config.config.tools;

  const agent = createAgent<string, WrappedAgentResult>({
    id: agentId,
    version: "1.0.0",
    description: config.description,
    expertise: { domains: ["general"], examples: [] },
    handler: async (prompt, { tools, stream, abortSignal }) => {
      try {
        // Use agent's system prompt directly - no attribution protocol injection
        const systemPrompt = config.config.prompt || "";

        stream?.emit({
          type: "data-tool-progress",
          data: { toolName: agentId, content: "Warming up..." },
        });

        // Filter tools based on agent config or workspace defaults
        // If agent specifies explicit tools, use those directly without workspace-level filtering
        // Otherwise, apply deny list to remove platform management tools while allowing MCP server tools
        // @FIXME: this should get rolled into the agent context builder.
        let filteredTools: AtlasTools;

        if (allowedToolNames && allowedToolNames.length > 0) {
          // Agent has explicit tool list - filter directly from all available tools
          const allowedSet = new Set(allowedToolNames);
          filteredTools = Object.fromEntries(
            Object.entries(tools).filter(([toolName]) => allowedSet.has(toolName)),
          );

          logger.debug("Applied agent-specific tool filtering", {
            agentId,
            toolCount: `${Object.keys(filteredTools).length}/${allowedToolNames.length}`,
          });
        } else {
          // No explicit tool list - apply deny list filtering to remove platform management tools
          // This preserves MCP server tools while blocking workspace/session/job/signal/agent management
          filteredTools = filterWorkspaceAgentTools(tools, logger);
        }

        // Build messages: static system prompt (cached for Anthropic), then variable content
        const isAnthropic = config.config.provider === "anthropic";
        const messages: Array<CoreSystemMessage | CoreUserMessage> = [
          {
            role: "system",
            content: systemPrompt,
            ...(isAnthropic ? { providerOptions: ANTHROPIC_CACHE_BREAKPOINT } : {}),
          },
          { role: "system", content: `Today's date: ${getTodaysDate()}` },
          { role: "user", content: prompt },
        ];

        const result = streamText({
          model,
          messages,
          tools: filteredTools,
          toolChoice: config.config.tool_choice || "auto",
          temperature: config.config.temperature,
          maxOutputTokens: config.config.max_tokens,
          maxRetries,
          stopWhen: stepCountIs(config.config.max_steps || 10),
          abortSignal,
          ...(config.config.provider_options || {}),
        });

        stream?.emit({
          type: "data-tool-progress",
          data: { toolName: agentId, content: "Creating results..." },
        });

        // NOTE: In current state its just printing whole output in the chat
        // pipeUIMessageStream(result.toUIMessageStream<AtlasUIMessage>(), stream);

        const [text, reasoning, toolCalls, toolResults, steps, usage] = await Promise.all([
          result.text,
          result.reasoningText,
          result.toolCalls,
          result.toolResults,
          result.steps,
          result.usage,
        ]);

        logger.debug("AI SDK generateObject completed", {
          agent: "from-llm-converter",
          step: "llm-agent-execution",
          usage,
        });

        const { assembledToolCalls, assembledToolResults } = collectToolUsageFromSteps({
          steps,
          toolCalls,
          toolResults,
        });

        const artifactRefs = extractArtifactRefsFromToolResults(assembledToolResults);

        return {
          reasoning,
          response: text,
          toolCalls: assembledToolCalls,
          toolResults: assembledToolResults,
          artifactRefs,
        };
      } catch (error) {
        // Simply check if we were aborted, don't try to detect from error
        if (abortSignal?.aborted) {
          logger.info("Wrapped agent execution cancelled", { agentId });
          stream?.emit({
            type: "data-tool-progress",
            data: { toolName: agentId, content: "Cancelling..." },
          });
          throw new DOMException("Agent execution cancelled", "AbortError");
        }

        // Enhanced error logging for API overload situations
        const isAPIError = error instanceof APICallError;
        const errorDetails = {
          agentId,
          error,
          errorType: error instanceof Error ? error.name : "Unknown",
          errorMessage: error instanceof Error ? error.message : String(error),
          statusCode: isAPIError ? error.statusCode : undefined,
          isRetryable: isAPIError ? error.isRetryable : false,
          // Specific handling for 529 Overloaded errors
          isOverloaded:
            (isAPIError && error.statusCode === 529) ||
            (error instanceof Error && error.message.includes("Overloaded")),
        };

        logger.error("Error when invoking wrapped agent", errorDetails);

        // Log guidance for overload errors
        if (errorDetails.isOverloaded) {
          logger.warn(
            `API overload detected for agent ${agentId}. The SDK will automatically retry up to ${maxRetries} times with exponential backoff.
            Consider:
            1. Adjusting max_retries in agent config (currently ${maxRetries})
            2. Monitoring API status at status.anthropic.com
            3. Implementing rate limiting if this persists`,
          );
        }

        // For 529 errors, throw with structured cause and user-friendly message
        if (isAPIError && error.statusCode === 529) {
          throwWithCause("API is overloaded. The service will automatically retry.", {
            type: "api",
            code: "OVERLOADED_ERROR",
            statusCode: 529,
          });
        }

        throw error;
      }
    },
  });

  return agent;
}
