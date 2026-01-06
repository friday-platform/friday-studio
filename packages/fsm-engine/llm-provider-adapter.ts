/**
 * Adapter for @atlas/llm registry to work with FSM engine's LLMProvider interface
 */

import { repairToolCall } from "@atlas/agent-sdk";
import { registry } from "@atlas/llm";
import type { Tool } from "ai";
import { generateText } from "ai";
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
  }): Promise<LLMResponse> {
    const modelId = `${this.provider}:${params.model || this.defaultModel}` as
      | `anthropic:${string}`
      | `openai:${string}`
      | `google:${string}`;

    const response = await generateText({
      model: registry.languageModel(modelId),
      prompt: params.prompt,
      tools: params.tools,
      toolChoice: params.toolChoice,
      experimental_repairToolCall: repairToolCall,
    });

    // Extract first tool call for calledTool field (used for failStep detection)
    const firstToolCall = response.toolCalls?.[0];
    const calledTool = firstToolCall
      ? { name: firstToolCall.toolName, args: firstToolCall.input }
      : undefined;

    return {
      content: response.text,
      data:
        response.toolCalls && response.toolCalls.length > 0
          ? { toolCalls: response.toolCalls, toolResults: response.toolResults }
          : undefined,
      calledTool,
    };
  }
}
