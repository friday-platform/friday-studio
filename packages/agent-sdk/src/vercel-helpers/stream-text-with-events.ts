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
  /** Accumulated reasoning text from reasoning-delta chunks, if the model produced any. */
  reasoning?: string;
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

  let reasoningAccumulator = "";
  const toolStartTimes = new Map<string, number>();

  for await (const chunk of result.fullStream) {
    if (!stream) continue;

    if (chunk.type === "tool-call") {
      toolStartTimes.set(chunk.toolCallId, Date.now());
      stream.emit({
        type: "tool-input-available",
        toolCallId: chunk.toolCallId,
        toolName: chunk.toolName,
        input: chunk.input,
      });
    } else if (chunk.type === "tool-result") {
      const start = toolStartTimes.get(chunk.toolCallId);
      if (start !== undefined) {
        const durationMs = Math.max(0, Date.now() - start);
        stream.emit({
          type: "data-tool-timing",
          data: { toolCallId: chunk.toolCallId, durationMs },
        });
        toolStartTimes.delete(chunk.toolCallId);
      }
      stream.emit({
        type: "tool-output-available",
        toolCallId: chunk.toolCallId,
        output: chunk.output,
      });
    } else if (chunk.type === "reasoning-start") {
      reasoningAccumulator = "";
      stream.emit({ type: "reasoning-start", id: chunk.id });
    } else if (chunk.type === "reasoning-delta") {
      reasoningAccumulator += chunk.text;
      stream.emit({ type: "reasoning-delta", id: chunk.id, delta: chunk.text });
    } else if (chunk.type === "reasoning-end") {
      stream.emit({ type: "reasoning-end", id: chunk.id });
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

  return {
    text,
    finishReason,
    usage,
    totalUsage,
    steps,
    toolCalls,
    toolResults,
    reasoning: reasoningAccumulator,
  };
}
