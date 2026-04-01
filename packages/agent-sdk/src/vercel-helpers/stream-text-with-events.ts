import type { FinishReason, LanguageModelUsage, StepResult, ToolSet } from "ai";
import { streamText } from "ai";
import type { StreamEmitter } from "../types.ts";

type StreamTextParams = Parameters<typeof streamText>[0];

/** Resolved result matching generateText's synchronous property access pattern. */
export interface ResolvedStreamResult {
  text: string;
  finishReason: FinishReason;
  usage: LanguageModelUsage;
  totalUsage: LanguageModelUsage;
  steps: Array<StepResult<ToolSet>>;
  toolCalls: Awaited<ReturnType<typeof streamText>["toolCalls"]>;
  toolResults: Awaited<ReturnType<typeof streamText>["toolResults"]>;
}

/**
 * Wrapper around `streamText` that forwards tool events via a StreamEmitter
 * and returns a resolved object matching `generateText`'s sync access pattern.
 *
 * Use this instead of `generateText` in bundled agents so that tool calls
 * are visible in the conversation UI in real time.
 *
 * When `stream` is undefined (e.g. cron/non-UI sessions), behaves identically
 * to `generateText` — no events emitted, just resolved properties.
 *
 * @example
 * ```ts
 * const result = await streamTextWithEvents({
 *   params: { model, tools, messages, ... },
 *   stream: context.stream,
 * });
 * // Access result.text, result.finishReason, etc. synchronously
 * ```
 */
export async function streamTextWithEvents({
  params,
  stream,
}: {
  params: StreamTextParams;
  stream?: StreamEmitter;
}): Promise<ResolvedStreamResult> {
  const result = streamText(params);

  for await (const chunk of result.fullStream) {
    if (!stream) continue;

    if (chunk.type === "tool-call") {
      stream.emit({
        type: "tool-input-available",
        toolCallId: chunk.toolCallId,
        toolName: chunk.toolName,
        input: chunk.input,
      });
    } else if (chunk.type === "tool-result") {
      stream.emit({
        type: "tool-output-available",
        toolCallId: chunk.toolCallId,
        output: chunk.output,
      });
    }
  }

  const [text, finishReason, usage, totalUsage, steps, toolCalls, toolResults] = await Promise.all([
    result.text,
    result.finishReason,
    result.usage,
    result.totalUsage,
    result.steps,
    result.toolCalls,
    result.toolResults,
  ]);

  return { text, finishReason, usage, totalUsage, steps, toolCalls, toolResults };
}
