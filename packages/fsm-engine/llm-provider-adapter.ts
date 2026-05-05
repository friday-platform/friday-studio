/** Adapts @atlas/llm registry to FSM engine's LLMProvider interface */

import type { AtlasUIMessageChunk } from "@atlas/agent-sdk";
import {
  type AgentExecutionError,
  type AgentExecutionSuccess,
  type AgentResult,
  repairToolCall,
} from "@atlas/agent-sdk";
import { collectToolUsageFromSteps } from "@atlas/agent-sdk/vercel-helpers";
import { createErrorCause, getErrorDisplayMessage, isAPIErrorCause } from "@atlas/core/errors";
import {
  buildRegistryModelId,
  getDefaultProviderOpts,
  isRegistryProvider,
  type LanguageModelV3,
  registry,
  traceModel,
} from "@atlas/llm";
import { logger } from "@atlas/logger";
import { stringifyError } from "@atlas/utils";
import type { ModelMessage, StopCondition, Tool } from "ai";
import { hasToolCall, stepCountIs, streamText } from "ai";
import type { FSMLLMOutput, LLMProvider } from "./types.ts";

export interface AtlasLLMProviderAdapterOptions {
  providerOptions?: Record<string, unknown>;
  maxSteps?: number;
}

const DEFAULT_OPTS_PROVIDERS = ["anthropic", "google", "groq", "openai"] as const;
type DefaultOptsProvider = (typeof DEFAULT_OPTS_PROVIDERS)[number];

function isDefaultOptsProvider(p: string): p is DefaultOptsProvider {
  return (DEFAULT_OPTS_PROVIDERS as readonly string[]).includes(p);
}

export class AtlasLLMProviderAdapter implements LLMProvider {
  private readonly defaultModel: LanguageModelV3;
  private readonly providerOptions?: Record<string, unknown>;
  private readonly maxSteps: number;

  constructor(defaultModel: LanguageModelV3, opts?: AtlasLLMProviderAdapterOptions) {
    this.defaultModel = defaultModel;
    this.providerOptions = opts?.providerOptions;
    this.maxSteps = opts?.maxSteps ?? 10;
  }

  private resolveOverride(provider: string, modelName: string): LanguageModelV3 {
    if (!isRegistryProvider(provider)) {
      throw new Error(
        `AtlasLLMProviderAdapter: provider '${provider}' is not a known registry provider; cannot resolve per-call override '${modelName}'`,
      );
    }
    return traceModel(registry.languageModel(buildRegistryModelId(provider, modelName)));
  }

  async call(params: {
    agentId: string;
    provider?: string;
    model: string;
    prompt: string;
    messages?: Array<ModelMessage>;
    tools?: Record<string, Tool>;
    toolChoice?: "auto" | "required" | "none" | { type: "tool"; toolName: string };
    stopOnToolCall?: string[];
    providerOptions?: Record<string, unknown>;
    onStreamEvent?: (chunk: AtlasUIMessageChunk) => void;
    abortSignal?: AbortSignal;
  }): Promise<AgentResult<string, FSMLLMOutput>> {
    const startMs = Date.now();
    const providerName = this.defaultModel.provider;
    const modelForCall =
      params.provider && params.model
        ? this.resolveOverride(params.provider, params.model)
        : this.defaultModel;
    const modelIdForLog = params.model
      ? `${providerName}:${params.model}`
      : `${providerName}:${this.defaultModel.modelId}`;

    const stopConditions: StopCondition<Record<string, Tool>>[] = [stepCountIs(this.maxSteps)];
    if (params.stopOnToolCall) {
      for (const toolName of params.stopOnToolCall) {
        stopConditions.push(hasToolCall(toolName));
      }
    }

    // The AI SDK throws `NoOutputGeneratedError` (with NO `cause` set) when
    // its stream errors before any step is recorded — see
    // node_modules/.deno/ai@*/.../ai/dist/index.mjs flush block. The actual
    // API failure (rate limit, auth, model deprecated, etc.) only reaches
    // the `onError` callback. Without this capture, every stream-error path
    // collapses to `{ code: UNKNOWN_ERROR, originalError: "No output
    // generated. Check the stream for errors." }` — useless for diagnosis.
    // Declared outside the try block so the catch can read it.
    let streamErrorCause: unknown;

    try {
      const defaultUserProviderOptions = isDefaultOptsProvider(providerName)
        ? getDefaultProviderOpts(providerName)
        : {};
      const promptOrMessages = params.messages
        ? { messages: params.messages }
        : {
            messages: [
              {
                role: "user" as const,
                content: params.prompt,
                providerOptions: defaultUserProviderOptions,
              },
            ],
          };

      const emitChunk = params.onStreamEvent;
      const result = streamText({
        model: modelForCall,
        ...promptOrMessages,
        tools: params.tools,
        toolChoice: params.toolChoice,
        experimental_repairToolCall: repairToolCall,
        stopWhen: stopConditions,
        abortSignal: params.abortSignal,
        ...(this.providerOptions || {}),
        ...(params.providerOptions || {}),
        onError: ({ error }) => {
          streamErrorCause = error;
        },
        onChunk: emitChunk
          ? ({ chunk }) => {
              if (chunk.type === "tool-call") {
                emitChunk({
                  type: "tool-input-available",
                  toolCallId: chunk.toolCallId,
                  toolName: chunk.toolName,
                  input: chunk.input,
                });
              } else if (chunk.type === "tool-result") {
                emitChunk({
                  type: "tool-output-available",
                  toolCallId: chunk.toolCallId,
                  output: chunk.output,
                });
              }
            }
          : undefined,
      });

      const [text, steps, toolCalls, toolResults] = await Promise.all([
        result.text,
        result.steps,
        result.toolCalls,
        result.toolResults,
      ]);

      // Flatten tool calls across all steps (toolCalls only has last step)
      const { assembledToolCalls, assembledToolResults } = collectToolUsageFromSteps({
        steps,
        toolCalls,
        toolResults,
      });

      // Raw text response - FSM engine extracts structured output from toolCalls
      const data: FSMLLMOutput = { response: text };

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
      // Prefer the underlying stream error captured via `onError` over the
      // outer `NoOutputGeneratedError` wrapper — the wrapper has no `cause`
      // set, so feeding it to `createErrorCause` always lands on
      // `UNKNOWN_ERROR`. The stream error is the real APICallError.
      const errorCause = createErrorCause(streamErrorCause ?? error);
      const reason = isAPIErrorCause(errorCause)
        ? getErrorDisplayMessage(errorCause)
        : stringifyError(streamErrorCause ?? error);

      logger.error(`LLM call failed: ${reason}`, {
        errorCause,
        model: modelIdForLog,
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
