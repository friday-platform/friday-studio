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
    system?: string;
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
    const providerName = params.provider ?? this.defaultModel.provider;
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

      // Anthropic caches a prefix up to and including any content block
      // marked with `cache_control`. Putting the static instruction surface
      // (action prompt + skills + validation) into a system message with
      // an explicit ephemeral marker lets a repeated call hit the cached
      // prefix even when the user message changes turn-to-turn. Other
      // providers ignore the anthropic-keyed providerOptions and either
      // see this as a plain system message (when passed in `messages`)
      // or fall back to the top-level `system` field.
      //
      // `allowSystemInMessages` opts in to system entries inside the
      // `messages` array — without it the AI SDK rejects them. The flag
      // is Anthropic-specific because the multi-system-block layout is
      // what the Anthropic provider uses to fan out per-block cache_control
      // markers; non-Anthropic providers keep the conventional top-level
      // `system` string.
      // The AI SDK's Anthropic provider sets `.provider` to the
      // surface-qualified id ("anthropic.messages", "anthropic.tools"),
      // never the bare "anthropic". Match the family prefix so any
      // future Anthropic surface gets the cache_control + system-
      // message layout. A strict `=== "anthropic"` would silently fall
      // through to the conventional `system` field with no cache
      // markers attached.
      const isAnthropic = providerName.startsWith("anthropic");
      const systemMessages: ModelMessage[] =
        isAnthropic && params.system
          ? [
              {
                role: "system",
                content: params.system,
                providerOptions: { anthropic: { cacheControl: { type: "ephemeral", ttl: "1h" } } },
              },
            ]
          : [];

      const userMessages: ModelMessage[] = params.messages
        ? params.messages
        : [
            {
              role: "user" as const,
              content: params.prompt,
              providerOptions: defaultUserProviderOptions,
            },
          ];

      // Provider-level strict-JSON-schema enforcement. OpenAI-compatible
      // providers (Groq, OpenAI, OpenRouter, LiteLLM) treat tool schemas as
      // advisory by default: they accept tool calls that violate `required`
      // and `additionalProperties: false`. Models exploit that and return
      // `{}` for tools whose schema actually requires fields, breaking the
      // FSM's `complete()` contract. Strict mode flips `strict: true` on
      // the function def so generation is constrained to the schema.
      //
      // Enabled unconditionally for non-Anthropic providers. Strict mode
      // triggers `response_format: json_schema` on the wire; older/smaller
      // models (gpt-oss-*, llama-3.x) will return HTTP 400 because they
      // don't support that format. That's an intentional upgrade over the
      // status quo where those models silently return `{}` — a clear
      // provider error tells the user "pick a different model" instead of
      // leaving them to debug an empty-output FSM. Anthropic ignores
      // `providerOptions.groq/openai`, so its path is unaffected.
      const strictModeProviderOptions: {
        groq?: { strictJsonSchema: boolean };
        openai?: { strictJsonSchema: boolean; structuredOutputs: boolean };
      } = {};
      if (providerName.startsWith("groq")) {
        strictModeProviderOptions.groq = { strictJsonSchema: true };
      } else if (providerName.startsWith("openai")) {
        strictModeProviderOptions.openai = { strictJsonSchema: true, structuredOutputs: true };
      }

      const emitChunk = params.onStreamEvent;
      const result = streamText({
        model: modelForCall,
        system: !isAnthropic ? params.system : undefined,
        messages: [...systemMessages, ...userMessages],
        allowSystemInMessages: isAnthropic ? true : undefined,
        tools: params.tools,
        toolChoice: params.toolChoice,
        experimental_repairToolCall: repairToolCall,
        stopWhen: stopConditions,
        abortSignal: params.abortSignal,
        providerOptions: strictModeProviderOptions,
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

      const [text, steps, toolCalls, toolResults, totalUsage] = await Promise.all([
        result.text,
        result.steps,
        result.toolCalls,
        result.toolResults,
        // `totalUsage` aggregates across all steps in the streamText loop;
        // `result.usage` is the last-step-only count and would undercount
        // multi-tool turns. Persist the full call cost.
        result.totalUsage,
      ]);

      // Flatten tool calls across all steps (toolCalls only has last step)
      const { assembledToolCalls, assembledToolResults } = collectToolUsageFromSteps({
        steps,
        toolCalls,
        toolResults,
      });

      // Raw text response - FSM engine extracts structured output from toolCalls
      const data: FSMLLMOutput = { response: text };

      // Project AI SDK usage into the persisted shape. Cache token fields
      // live under `inputTokenDetails` in the SDK; flatten so consumers
      // (event mapper, session reducer) don't need to know the SDK shape.
      // The model id reported back is the registry-qualified id we logged
      // above so retrospective grouping matches what shows up in traces.
      const usage = {
        inputTokens: totalUsage.inputTokens,
        outputTokens: totalUsage.outputTokens,
        cacheReadTokens: totalUsage.inputTokenDetails?.cacheReadTokens,
        cacheWriteTokens: totalUsage.inputTokenDetails?.cacheWriteTokens,
        model: modelIdForLog,
      };

      return {
        agentId: params.agentId,
        timestamp: new Date().toISOString(),
        input: params.prompt,
        ok: true,
        data,
        durationMs: Date.now() - startMs,
        toolCalls: assembledToolCalls,
        toolResults: assembledToolResults,
        usage,
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
