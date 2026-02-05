/** Adapts @atlas/llm registry to FSM engine's LLMProvider interface */

import {
  type AgentExecutionError,
  type AgentExecutionSuccess,
  type AgentResult,
  repairToolCall,
} from "@atlas/agent-sdk";
import { collectToolUsageFromSteps } from "@atlas/agent-sdk/vercel-helpers";
import { registry } from "@atlas/llm";
import { stringifyError } from "@atlas/utils";
import type { StopCondition, Tool } from "ai";
import { generateText, hasToolCall, stepCountIs } from "ai";
import type { FSMLLMOutput, LLMProvider } from "./types.ts";

export class AtlasLLMProviderAdapter implements LLMProvider {
  constructor(
    private defaultModel: string,
    private provider: "anthropic" | "openai" | "google" = "anthropic",
  ) {}

  async call(params: {
    agentId: string;
    model: string;
    prompt: string;
    tools?: Record<string, Tool>;
    toolChoice?: "auto" | "required" | "none";
    stopOnToolCall?: string[];
  }): Promise<AgentResult<string, FSMLLMOutput>> {
    const startMs = Date.now();
    const modelId = `${this.provider}:${params.model || this.defaultModel}` as
      | `anthropic:${string}`
      | `openai:${string}`
      | `google:${string}`;

    const stopConditions: StopCondition<Record<string, Tool>>[] = [
      stepCountIs(10), // Max steps before forcing completion
    ];
    if (params.stopOnToolCall) {
      for (const toolName of params.stopOnToolCall) {
        stopConditions.push(hasToolCall(toolName));
      }
    }

    try {
      const response = await generateText({
        model: registry.languageModel(modelId),
        prompt: params.prompt,
        tools: params.tools,
        toolChoice: params.toolChoice,
        experimental_repairToolCall: repairToolCall,
        stopWhen: stopConditions,
      });

      // Flatten tool calls across all steps (response.toolCalls only has last step)
      const { assembledToolCalls, assembledToolResults } = collectToolUsageFromSteps(response);

      // Raw text response - FSM engine extracts structured output from toolCalls
      const data: FSMLLMOutput = { response: response.text };

      return {
        agentId: params.agentId,
        timestamp: new Date().toISOString(),
        input: params.prompt,
        ok: true,
        data,
        durationMs: Date.now() - startMs,
        toolCalls: assembledToolCalls,
        toolResults: assembledToolResults,
      } satisfies AgentExecutionSuccess<string, FSMLLMOutput>;
    } catch (error) {
      return {
        agentId: params.agentId,
        timestamp: new Date().toISOString(),
        input: params.prompt,
        ok: false,
        error: { reason: stringifyError(error) },
        durationMs: Date.now() - startMs,
      } satisfies AgentExecutionError<string>;
    }
  }
}
