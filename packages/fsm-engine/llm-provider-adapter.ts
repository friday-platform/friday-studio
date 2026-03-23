/** Adapts @atlas/llm registry to FSM engine's LLMProvider interface */

import {
  type AgentExecutionError,
  type AgentExecutionSuccess,
  type AgentResult,
  repairToolCall,
} from "@atlas/agent-sdk";
import { collectToolUsageFromSteps } from "@atlas/agent-sdk/vercel-helpers";
import { createErrorCause, getErrorDisplayMessage, isAPIErrorCause } from "@atlas/core/errors";
import { getDefaultProviderOpts, registry, traceModel } from "@atlas/llm";
import { logger } from "@atlas/logger";
import { stringifyError } from "@atlas/utils";
import type { CoreMessage, StopCondition, Tool } from "ai";
import { generateText, hasToolCall, stepCountIs } from "ai";
import type { FSMLLMOutput, LLMProvider } from "./types.ts";

export class AtlasLLMProviderAdapter implements LLMProvider {
  private maxSteps: number;

  constructor(
    private defaultModel: string,
    private provider: "anthropic" | "openai" | "google" | "groq" = "anthropic",
    private providerOptions?: Record<string, unknown>,
    maxSteps?: number,
  ) {
    this.maxSteps = maxSteps ?? 10;
  }

  async call(params: {
    agentId: string;
    model: string;
    prompt: string;
    messages?: Array<CoreMessage>;
    tools?: Record<string, Tool>;
    toolChoice?: "auto" | "required" | "none";
    stopOnToolCall?: string[];
    providerOptions?: Record<string, unknown>;
  }): Promise<AgentResult<string, FSMLLMOutput>> {
    const startMs = Date.now();
    const modelId = `${this.provider}:${params.model || this.defaultModel}` as
      | `anthropic:${string}`
      | `openai:${string}`
      | `google:${string}`
      | `groq:${string}`;

    const stopConditions: StopCondition<Record<string, Tool>>[] = [stepCountIs(this.maxSteps)];
    if (params.stopOnToolCall) {
      for (const toolName of params.stopOnToolCall) {
        stopConditions.push(hasToolCall(toolName));
      }
    }

    try {
      const promptOrMessages = params.messages
        ? { messages: params.messages }
        : {
            messages: [
              {
                role: "user" as const,
                content: params.prompt,
                providerOptions: getDefaultProviderOpts(this.provider),
              },
            ],
          };

      const response = await generateText({
        model: traceModel(registry.languageModel(modelId)),
        ...promptOrMessages,
        tools: params.tools,
        toolChoice: params.toolChoice,
        experimental_repairToolCall: repairToolCall,
        stopWhen: stopConditions,
        ...(this.providerOptions || {}),
        ...(params.providerOptions || {}),
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
      const toolCount = params.tools ? Object.keys(params.tools).length : 0;
      const errorCause = createErrorCause(error);
      const reason = isAPIErrorCause(errorCause)
        ? getErrorDisplayMessage(errorCause)
        : stringifyError(error);

      logger.error(`LLM call failed: ${reason}`, {
        errorCause,
        model: modelId,
        toolCount,
        agentId: params.agentId,
      });

      return {
        agentId: params.agentId,
        timestamp: new Date().toISOString(),
        input: params.prompt,
        ok: false,
        error: { reason },
        durationMs: Date.now() - startMs,
      } satisfies AgentExecutionError<string>;
    }
  }
}
