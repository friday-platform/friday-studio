/**
 * Reusable test utilities for eval test files.
 *
 * - `createMockModel()` — configurable LanguageModelV3 mock with call recording,
 *   modeled after AI SDK's MockLanguageModel (inlined to avoid msw transitive dep).
 */

import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3Content,
  LanguageModelV3StreamPart,
} from "@ai-sdk/provider";

/** Converts an array of values into a ReadableStream that enqueues them synchronously. */
function arrayToStream<T>(values: T[]): ReadableStream<T> {
  return new ReadableStream<T>({
    start(controller) {
      for (const v of values) controller.enqueue(v);
      controller.close();
    },
  });
}

/** Configuration for the mock model factory. */
export interface MockModelOptions {
  /** Model identifier (default: "mock:mock-model"). */
  modelId?: string;
  /** Text content returned by doGenerate/doStream (default: "mock response"). */
  text?: string;
  /** Tool calls returned by doGenerate (default: none). */
  toolCalls?: Array<{ toolName: string; input: string }>;
}

/**
 * A LanguageModelV3 mock that records calls for assertion.
 *
 * Mirrors the AI SDK's `MockLanguageModel` API (call recording via
 * `doGenerateCalls` / `doStreamCalls`) without pulling in `ai/test`,
 * which drags `msw` through `@ai-sdk/provider-utils/test` — a dep
 * that doesn't resolve under Deno.
 */
export interface MockModel extends LanguageModelV3 {
  /** Arguments passed to each doGenerate invocation, in order. */
  doGenerateCalls: LanguageModelV3CallOptions[];
  /** Arguments passed to each doStream invocation, in order. */
  doStreamCalls: LanguageModelV3CallOptions[];
}

/**
 * Creates a LanguageModelV3 mock with eval-specific defaults and call recording.
 *
 * @param options - Override default text, toolCalls, or modelId
 */
export function createMockModel(options?: MockModelOptions): MockModel {
  const modelId = options?.modelId ?? "mock:mock-model";
  const text = options?.text ?? "mock response";
  const toolCalls = options?.toolCalls ?? [];

  const content: LanguageModelV3Content[] = [
    { type: "text" as const, text },
    ...toolCalls.map((tc, i) => ({
      type: "tool-call" as const,
      toolCallId: `call-${i}`,
      toolName: tc.toolName,
      input: tc.input,
    })),
  ];

  const buildStreamChunks = (): LanguageModelV3StreamPart[] => [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "t1" },
    { type: "text-delta", id: "t1", delta: text },
    { type: "text-end", id: "t1" },
    ...toolCalls.flatMap((tc) => [
      { type: "tool-input-start" as const, id: `tc-${tc.toolName}`, toolName: tc.toolName },
      { type: "tool-input-delta" as const, id: `tc-${tc.toolName}`, delta: tc.input },
      { type: "tool-input-end" as const, id: `tc-${tc.toolName}` },
    ]),
    {
      type: "finish" as const,
      usage: {
        inputTokens: {
          total: 100,
          noCache: undefined,
          cacheRead: undefined,
          cacheWrite: undefined,
        },
        outputTokens: { total: 50, text: undefined, reasoning: undefined },
      },
      finishReason: { unified: "stop" as const, raw: undefined },
    },
  ];

  const doGenerateCalls: LanguageModelV3CallOptions[] = [];
  const doStreamCalls: LanguageModelV3CallOptions[] = [];

  return {
    specificationVersion: "v3",
    provider: modelId.split(":")[0] ?? "mock",
    modelId,
    supportedUrls: {},
    doGenerateCalls,
    doStreamCalls,

    // deno-lint-ignore require-await
    doGenerate: async (options: LanguageModelV3CallOptions) => {
      doGenerateCalls.push(options);
      return {
        content,
        finishReason: { unified: "stop" as const, raw: undefined },
        usage: {
          inputTokens: {
            total: 100,
            noCache: undefined,
            cacheRead: undefined,
            cacheWrite: undefined,
          },
          outputTokens: { total: 50, text: undefined, reasoning: undefined },
        },
        warnings: [],
      };
    },

    // deno-lint-ignore require-await
    doStream: async (options: LanguageModelV3CallOptions) => {
      doStreamCalls.push(options);
      return { stream: arrayToStream(buildStreamChunks()) };
    },
  };
}
