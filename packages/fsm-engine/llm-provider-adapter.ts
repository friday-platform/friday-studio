/**
 * Adapter for @atlas/llm registry to work with FSM engine's LLMProvider interface
 */

import { repairToolCall } from "@atlas/agent-sdk";
import { collectToolUsageFromSteps } from "@atlas/agent-sdk/vercel-helpers";
import { registry } from "@atlas/llm";
import type { StopCondition, Tool } from "ai";
import { generateText, hasToolCall, stepCountIs } from "ai";
import type { LLMProvider, LLMResponse } from "./types.ts";

/**
 * Wraps @atlas/llm's registry to match FSM engine's interface
 */
export class AtlasLLMProviderAdapter implements LLMProvider {
  constructor(
    private defaultModel: string,
    private provider: "anthropic" | "openai" | "google" = "anthropic",
  ) {}

  async call(params: {
    model: string;
    prompt: string;
    tools?: Record<string, Tool>;
    toolChoice?: "auto" | "required" | "none";
    stopOnToolCall?: string[];
  }): Promise<LLMResponse> {
    const modelId = `${this.provider}:${params.model || this.defaultModel}` as
      | `anthropic:${string}`
      | `openai:${string}`
      | `google:${string}`;

    // Build stopWhen conditions: always include step limit, add tool call stops if specified
    const stopConditions: StopCondition<Record<string, Tool>>[] = [
      stepCountIs(10), // Give LLM room to gather info before completing task
    ];
    if (params.stopOnToolCall) {
      for (const toolName of params.stopOnToolCall) {
        stopConditions.push(hasToolCall(toolName));
      }
    }

    const response = await generateText({
      model: registry.languageModel(modelId),
      prompt: params.prompt,
      tools: params.tools,
      toolChoice: params.toolChoice,
      experimental_repairToolCall: repairToolCall,
      stopWhen: stopConditions,
    });

    // Aggregate tool calls/results across ALL steps (response.toolCalls only has last step)
    const { assembledToolCalls, assembledToolResults } = collectToolUsageFromSteps(response);

    // Extract first tool call for calledTool field (used for failStep detection)
    const firstToolCall = assembledToolCalls[0];
    const calledTool = firstToolCall
      ? { name: firstToolCall.toolName, args: firstToolCall.input }
      : undefined;

    return {
      content: response.text,
      data:
        assembledToolCalls.length > 0
          ? { toolCalls: assembledToolCalls, toolResults: assembledToolResults }
          : undefined,
      calledTool,
    };
  }
}
