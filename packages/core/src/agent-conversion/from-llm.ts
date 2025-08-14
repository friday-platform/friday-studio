/**
 * LLM Config to SDK Agent Conversion
 *
 * Converts workspace.yml LLM agent configs into AtlasAgent instances.
 * Enables workspace-defined agents to use the same execution infrastructure
 * as standalone .agent.yml files.
 */

import { generateText, stepCountIs } from "ai";
import { APICallError } from "@ai-sdk/provider";
import { createAgent } from "@atlas/agent-sdk";
import type { AgentContext, AtlasAgent, ToolResult } from "@atlas/agent-sdk";
import type { LLMAgentConfig } from "@atlas/config";
import { registry, validateProviderConfig } from "../llm-provider-registry/index.ts";
import type { Logger } from "@atlas/logger";
import { ensureSourceAttributionProtocol } from "../prompts/source-attribution.ts";

export type WrappedAgentResult = {
  response: string;
  reasoning?: string;
  toolCalls?: string[];
  toolResults?: ToolResult[];
};
export type WrappedAgent = AtlasAgent<WrappedAgentResult>;

/**
 * Extract tool calls and results from generateText response.
 * Falls back to manual extraction from steps when direct access returns empty arrays.
 */
function extractToolData(res: any): { toolCalls: string[]; toolResults: ToolResult[] } {
  let toolCalls: string[] = [];
  let toolResults: ToolResult[] = [];

  // Try direct access first and transform to required format
  if (res.toolCalls && Array.isArray(res.toolCalls) && res.toolCalls.length > 0) {
    toolCalls = res.toolCalls.map((call: any) => call.toolName || call.name || "").filter(Boolean);
  }
  if (res.toolResults && Array.isArray(res.toolResults) && res.toolResults.length > 0) {
    toolResults = res.toolResults.map((result: any) => ({
      toolName: result.toolName || result.name || "",
      isError: Boolean(result.isError || result.error),
      input: result.input || result.args || {},
    })).filter((result: ToolResult) => result.toolName);
  }

  // If no direct data available, extract from steps
  if (toolCalls.length === 0 && res.steps) {
    const toolCallsFromSteps: string[] = [];
    const toolResultsFromSteps: ToolResult[] = [];

    for (const step of res.steps) {
      if (step.content && Array.isArray(step.content)) {
        for (const contentItem of step.content) {
          if (contentItem.type === "tool-call" && contentItem.toolName) {
            toolCallsFromSteps.push(contentItem.toolName);
          }
          if (contentItem.type === "tool-result" && contentItem.toolName) {
            toolResultsFromSteps.push({
              toolName: contentItem.toolName,
              isError: Boolean(contentItem.isError),
              input: contentItem.input || {},
            });
          }
        }
      }
    }

    if (toolCallsFromSteps.length > 0) {
      toolCalls = toolCallsFromSteps;
    }
    if (toolResultsFromSteps.length > 0) {
      toolResults = toolResultsFromSteps;
    }
  }

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
): AtlasAgent {
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
          tools: context.tools,
          toolChoice: config.config.tool_choice || "auto",
          temperature: config.config.temperature,
          maxOutputTokens: config.config.max_tokens,
          maxRetries,
          stopWhen: stepCountIs(config.config.max_steps || 10),
          ...(config.config.provider_options || {}),
        });

        // Extract tool calls and results using the helper function
        const { toolCalls, toolResults } = extractToolData(res);

        return {
          reasoning: res.reasoningText,
          response: res.text,
          toolCalls,
          toolResults,
        };
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
          isOverloaded: (isAPIError && error.statusCode === 529) ||
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
