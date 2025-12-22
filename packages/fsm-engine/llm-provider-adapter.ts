/**
 * Adapter for @atlas/llm registry to work with FSM engine's LLMProvider interface
 */

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
  }): Promise<LLMResponse> {
    const modelId = `${this.provider}:${params.model || this.defaultModel}` as
      | `anthropic:${string}`
      | `openai:${string}`
      | `google:${string}`;

    const response = await generateText({
      model: registry.languageModel(modelId),
      prompt: params.prompt,
      tools: params.tools,
    });

    return {
      content: response.text,
      data:
        response.toolCalls && response.toolCalls.length > 0
          ? {
              toolCalls: response.toolCalls.map((tc) => ({
                id: tc.toolCallId,
                name: tc.toolName,
                input: tc.input,
              })),
              toolResults: response.toolResults?.map((tr) => ({
                id: tr.toolCallId,
                toolName: tr.toolName,
                input: tr.input,
                output: tr.output,
              })),
            }
          : undefined,
    };
  }
}
