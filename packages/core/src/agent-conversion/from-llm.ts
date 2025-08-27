/**
 * LLM Config to SDK Agent Conversion
 *
 * Converts workspace.yml LLM agent configs into AtlasAgent instances.
 * Enables workspace-defined agents to use the same execution infrastructure
 * as standalone .agent.yml files.
 */

import { APICallError } from "@ai-sdk/provider";
import type { AgentContext, AtlasAgent, AtlasTools, ToolCall, ToolResult } from "@atlas/agent-sdk";
import { createAgent } from "@atlas/agent-sdk";
import type { LLMAgentConfig } from "@atlas/config";
import type { Logger } from "@atlas/logger";
import { generateText, stepCountIs } from "ai";
import type { StepResult, TypedToolCall, TypedToolResult } from "ai";
import { registry, validateProviderConfig } from "../llm-provider-registry/index.ts";
import { ensureSourceAttributionProtocol } from "../prompts/source-attribution.ts";

export type WrappedAgentResult = {
  response: string;
  reasoning?: string;
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
};
export type WrappedAgent = AtlasAgent<WrappedAgentResult>;

/**
 * Collect tool usage from AI SDK `generateText` response, preferring per-step data.
 *
 * Why this exists:
 * - The AI SDK exposes tool usage both at the top-level (last step only) and per-step in `steps`.
 * - Dynamic tool calls frequently appear only inside `steps`.
 * - We must return a complete, canonical view of all tool calls/results to Atlas.
 *
 * Strategy:
 * - Flatten `steps[].toolCalls` and `steps[].toolResults` to capture all dynamic and static calls.
 * - If no per-step entries exist, fall back to top-level `toolCalls`/`toolResults` (which represent the last step).
 *
 * Type notes:
 * - Uses `AtlasTools` to align with Atlas tool registry shape (Record<string, Tool>).
 * - Returns `ToolCall`/`ToolResult` which are the Atlas SDK aliases of AI SDK branded types.
 */
function collectToolUsageFromSteps(res: {
  steps?: Array<StepResult<AtlasTools>>;
  toolCalls?: Array<TypedToolCall<AtlasTools>>;
  toolResults?: Array<TypedToolResult<AtlasTools>>;
}): { toolCalls: ToolCall[]; toolResults: ToolResult[] } {
  const steps: Array<StepResult<AtlasTools>> = Array.isArray(res.steps) ? res.steps : [];

  const stepToolCalls: Array<TypedToolCall<AtlasTools>> = steps.flatMap(
    (step) => step.toolCalls ?? [],
  );
  const stepToolResults: Array<TypedToolResult<AtlasTools>> = steps.flatMap(
    (step) => step.toolResults ?? [],
  );

  const toolCalls: ToolCall[] =
    stepToolCalls.length > 0 ? stepToolCalls : Array.isArray(res.toolCalls) ? res.toolCalls : [];

  const toolResults: ToolResult[] =
    stepToolResults.length > 0
      ? stepToolResults
      : Array.isArray(res.toolResults)
        ? res.toolResults
        : [];

  return { toolCalls, toolResults };
}

/**
 * Convert workspace LLM config to AtlasAgent.
 * Creates a runnable agent using workspace.yml LLM settings.
 */
export function convertLLMToAgent(
  config: LLMAgentConfig,
  agentId: string,
  logger: Logger,
): AtlasAgent<WrappedAgentResult> {
  // Use configured retries or default to 3 for better resilience against 529 errors
  const maxRetries = config.config.max_retries ?? 3;

  validateProviderConfig(config.config.provider);
  const model = registry.languageModel(`${config.config.provider}:${config.config.model}`);

  const agent = createAgent<WrappedAgentResult>({
    id: agentId,
    version: "1.0.0",
    description: config.description,
    metadata: {},
    expertise: { domains: ["general"], capabilities: ["general"], examples: [] },
    handler: async (prompt: string, context: AgentContext) => {
      try {
        // Enforce source attribution protocol in system prompt (idempotent)
        const systemPromptWithAttribution = ensureSourceAttributionProtocol(
          `${config.config.prompt || ""}\n\n` +
            "Do NOT include source tags inside tool arguments or user-facing content (e.g., emails, posts). Use tags in assistant responses only. Include plain URLs/paths in user-facing content when helpful.",
        );

        // Include current datetime for temporal grounding
        const nowUtcIso = new Date().toISOString();
        const datetimeHeader = `Current datetime (UTC): ${nowUtcIso}`;

        const res = await generateText({
          model,
          system: `${datetimeHeader}\n\n${systemPromptWithAttribution}`,
          messages: [{ role: "user" as const, content: prompt }],
          tools: { ...context.tools },
          toolChoice: config.config.tool_choice || "auto",
          temperature: config.config.temperature,
          maxOutputTokens: config.config.max_tokens,
          maxRetries,
          stopWhen: stepCountIs(config.config.max_steps || 10),
          ...(config.config.provider_options || {}),
        });

        const { toolCalls, toolResults } = collectToolUsageFromSteps(res);
        return { reasoning: res.reasoningText, response: res.text, toolCalls, toolResults };
        // if (streaming && context.stream) {
        //   return await handleStreamingResponse(commonOptions, context);
        // } else {
        //   return await handleNonStreamingResponse(commonOptions);
        // }
      } catch (error) {
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

        // if (context.stream) {
        //   const errorEvent: StreamEvent = {
        //     type: "error",
        //     error: error instanceof Error ? error : new Error(String(error)),
        //   };
        //   context.stream.emit(errorEvent);
        // }
        throw error;
      }
    },
  });

  return agent;
}

// /** Handle streaming LLM response with event emission. */
// async function handleStreamingResponse(
//   options: Parameters<typeof streamText>[0],
//   context: AgentContext,
// ): Promise<unknown> {
//   const result = streamText(options);
//   let fullText = "";
//   const toolCalls: Array<{ id: string; name: string; args: unknown }> = [];
//   for await (const chunk of result.textStream) {
//     fullText += chunk;
//     const textEvent: StreamEvent = {
//       type: "text",
//       content: chunk,
//     };
//     context.stream!.emit(textEvent);
//   }

//   const toolCallsArray = await result.toolCalls;
//   if (toolCallsArray && toolCallsArray.length > 0) {
//     for (const toolCall of toolCallsArray) {
//       const toolCallEvent: StreamEvent = {
//         type: "tool-call",
//         toolName: toolCall.toolName,
//         args: toolCall.input,
//       };
//       context.stream!.emit(toolCallEvent);
//       toolCalls.push({
//         id: toolCall.toolCallId,
//         name: toolCall.toolName,
//         args: toolCall.input,
//       });
//     }
//   }

//   const usage = await result.usage;
//   if (usage) {
//     const usageEvent: StreamEvent = {
//       type: "usage",
//       tokens: {
//         input: usage.inputTokens,
//         output: usage.outputTokens,
//         total: usage.totalTokens,
//       },
//     };
//     context.stream!.emit(usageEvent);
//   }

//   const finishEvent: StreamEvent = { type: "finish" };
//   context.stream!.emit(finishEvent);

//   return {
//     response: fullText,
//     toolCalls,
//     usage: usage
//       ? {
//         promptTokens: usage.inputTokens,
//         completionTokens: usage.outputTokens,
//         totalTokens: usage.totalTokens,
//       }
//       : undefined,
//   };
// }

// /** Handle non-streaming LLM response. */
// async function handleNonStreamingResponse(
//   options: Parameters<typeof generateText>[0],
// ): Promise<unknown> {
//   const result = await generateText(options);
//   return {
//     response: result.text,
//     toolCalls: result.toolCalls,
//     usage: result.usage
//       ? {
//         promptTokens: result.usage.inputTokens,
//         completionTokens: result.usage.outputTokens,
//         totalTokens: result.usage.totalTokens,
//       }
//       : undefined,
//   };
// }
