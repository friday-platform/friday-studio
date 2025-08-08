/**
 * LLM Config to SDK Agent Conversion
 *
 * Converts workspace.yml LLM agent configs into AtlasAgent instances.
 * Enables workspace-defined agents to use the same execution infrastructure
 * as standalone .agent.yml files.
 */

import { generateText, stepCountIs } from "ai";
import { createAgent } from "@atlas/agent-sdk";
import type { AtlasAgent } from "@atlas/agent-sdk";
import type { LLMAgentConfig } from "@atlas/config";
import { registry, validateProviderConfig } from "../llm-provider-registry/index.ts";
import type { Logger } from "@atlas/logger";

/**
 * Convert workspace LLM config to AtlasAgent.
 * Creates a runnable agent using workspace.yml LLM settings.
 */
export function convertLLMToAgent(
  config: LLMAgentConfig,
  agentId: string,
  logger: Logger,
): AtlasAgent {
  const maxRetries = 0;

  validateProviderConfig(config.config.provider);
  const model = registry.languageModel(`${config.config.provider}:${config.config.model}`);

  const agent = createAgent({
    id: agentId,
    version: "1.0.0",
    description: config.description,
    metadata: {},
    expertise: { domains: ["general"], capabilities: ["general"], examples: [] },
    handler: async (prompt, { tools }) => {
      try {
        const res = await generateText({
          model,
          system: config.config.prompt,
          messages: [{ role: "user" as const, content: prompt }],
          tools,
          toolChoice: config.config.tool_choice || "auto",
          temperature: config.config.temperature,
          maxOutputTokens: config.config.max_tokens,
          maxRetries,
          stopWhen: stepCountIs(config.config.max_steps || 10),
          ...(config.config.provider_options || {}),
        });

        return res.text;
        // if (streaming && context.stream) {
        //   return await handleStreamingResponse(commonOptions, context);
        // } else {
        //   return await handleNonStreamingResponse(commonOptions);
        // }
      } catch (error) {
        logger.error("Error when  invoking wrapped agent", { error });
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
