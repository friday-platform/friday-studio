import { APICallError } from "@ai-sdk/provider";
import type { AtlasAgent, ToolCall, ToolResult } from "@atlas/agent-sdk";
import { createAgent } from "@atlas/agent-sdk";
import { pipeUIMessageStream, collectToolUsageFromSteps } from "@atlas/agent-sdk/vercel-helpers";
import type { LLMAgentConfig } from "@atlas/config";
import type { Logger } from "@atlas/logger";
import { stepCountIs, streamText } from "ai";
import { registry, validateProviderConfig } from "../llm-provider-registry/index.ts";
import { ensureSourceAttributionProtocol } from "../prompts/source-attribution.ts";

export type WrappedAgentResult = {
  response: string;
  reasoning?: string;
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
};
export type WrappedAgent = AtlasAgent<WrappedAgentResult>;

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

  const agent = createAgent<WrappedAgentResult>({
    id: agentId,
    version: "1.0.0",
    description: config.description,
    expertise: { domains: ["general"], examples: [] },
    handler: async (prompt, { tools, stream, abortSignal }) => {
      try {
        // Enforce source attribution protocol in system prompt (idempotent)
        const systemPromptWithAttribution = ensureSourceAttributionProtocol(
          `${config.config.prompt || ""}\n\n` +
            "Do NOT include source tags inside tool arguments or user-facing content (e.g., emails, posts). Use tags in assistant responses only. Include plain URLs/paths in user-facing content when helpful.",
        );

        // Include current datetime for temporal grounding
        const nowUtcIso = new Date().toISOString();
        const datetimeHeader = `Current datetime (UTC): ${nowUtcIso}`;

        const result = streamText({
          model,
          system: `${datetimeHeader}\n\n${systemPromptWithAttribution}`,
          messages: [{ role: "user" as const, content: prompt }],
          tools,
          toolChoice: config.config.tool_choice || "auto",
          temperature: config.config.temperature,
          maxOutputTokens: config.config.max_tokens,
          maxRetries,
          stopWhen: stepCountIs(config.config.max_steps || 10),
          abortSignal,
          ...(config.config.provider_options || {}),
        });

        pipeUIMessageStream(result.toUIMessageStream(), stream);

        const [text, reasoning, toolCalls, toolResults, steps] = await Promise.all([
          result.text,
          result.reasoningText,
          result.toolCalls,
          result.toolResults,
          result.steps,
        ]);

        const { assembledToolCalls, assembledToolResults } = collectToolUsageFromSteps({
          steps,
          toolCalls,
          toolResults,
        });
        return {
          reasoning,
          response: text,
          toolCalls: assembledToolCalls,
          toolResults: assembledToolResults,
        };
      } catch (error) {
        // Simply check if we were aborted, don't try to detect from error
        if (abortSignal?.aborted) {
          logger.info("Wrapped agent execution cancelled", { agentId });
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

        throw error;
      }
    },
  });

  return agent;
}
