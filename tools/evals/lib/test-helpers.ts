/**
 * Reusable test utilities for eval test files.
 *
 * - `createMockModel()` — configurable LanguageModelV2 mock with call recording,
 *   modeled after AI SDK's MockLanguageModelV2 (inlined to avoid msw transitive dep).
 */

import type {
  LanguageModelV2,
  LanguageModelV2CallOptions,
  LanguageModelV2StreamPart,
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
 * A LanguageModelV2 mock that records calls for assertion.
 *
 * Mirrors the AI SDK's `MockLanguageModelV2` API (call recording via
 * `doGenerateCalls` / `doStreamCalls`) without pulling in `ai/test`,
 * which drags `msw` through `@ai-sdk/provider-utils/test` — a dep
 * that doesn't resolve under Deno.
 */
export interface MockModel extends LanguageModelV2 {
  /** Arguments passed to each doGenerate invocation, in order. */
  doGenerateCalls: LanguageModelV2CallOptions[];
  /** Arguments passed to each doStream invocation, in order. */
  doStreamCalls: LanguageModelV2CallOptions[];
}

/**
 * Creates a LanguageModelV2 mock with eval-specific defaults and call recording.
 *
 * @param options - Override default text, toolCalls, or modelId
 */
export function createMockModel(options?: MockModelOptions): MockModel {
  const modelId = options?.modelId ?? "mock:mock-model";
  const text = options?.text ?? "mock response";
  const toolCalls = options?.toolCalls ?? [];

  const content: Awaited<ReturnType<LanguageModelV2["doGenerate"]>>["content"] = [
    { type: "text" as const, text },
    ...toolCalls.map((tc, i) => ({
      type: "tool-call" as const,
      toolCallId: `call-${i}`,
      toolName: tc.toolName,
      input: tc.input,
    })),
  ];

  const buildStreamChunks = (): LanguageModelV2StreamPart[] => [
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
      usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      finishReason: "stop" as const,
    },
  ];

  const doGenerateCalls: LanguageModelV2CallOptions[] = [];
  const doStreamCalls: LanguageModelV2CallOptions[] = [];

  return {
    specificationVersion: "v2",
    provider: modelId.split(":")[0] ?? "mock",
    modelId,
    supportedUrls: {},
    doGenerateCalls,
    doStreamCalls,

    // deno-lint-ignore require-await
    doGenerate: async (options: LanguageModelV2CallOptions) => {
      doGenerateCalls.push(options);
      return {
        content,
        finishReason: "stop" as const,
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
        warnings: [],
      };
    },

    // deno-lint-ignore require-await
    doStream: async (options: LanguageModelV2CallOptions) => {
      doStreamCalls.push(options);
      return { stream: arrayToStream(buildStreamChunks()) };
    },
  };
}
