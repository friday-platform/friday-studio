import type { StreamTextResult, ToolSet } from "ai";
import type { StreamEmitter } from "../types.ts";

/**
 * Maps a Vercel AI SDK fullStream result to Atlas stream events.
 *
 * This helper processes all events from the AI SDK's fullStream and automatically:
 * - Streams text chunks as they arrive
 * - Emits reasoning/thinking content in real-time
 * - Forwards tool calls with their arguments
 * - Streams source references as custom events
 * - Reports step progress during multi-step operations
 * - Emits usage statistics when available
 * - Signals completion with finish reason
 * - Maps unknown event types to custom Atlas events
 *
 * @example
 * ```typescript
 * import { convertResultStream } from "@atlas/agent-sdk/vercel-helpers";
 * import { streamText } from "ai";
 * import { anthropic } from "@ai-sdk/anthropic";
 *
 * export const myAgent = createAgent({
 *   async handler(prompt, { stream }) {
 *     const result = streamText({
 *       model: anthropic("claude-3-sonnet"),
 *       prompt,
 *       tools: {},
 *     });
 *
 *     return await convertResultStream(result, stream);
 *   }
 * });
 * ```
 *
 * @param aiResult - The result from a Vercel AI SDK streaming operation
 * @param atlasStream - The Atlas stream emitter
 * @returns The complete response text and metadata
 */
export async function streamResults(
  aiResult: StreamTextResult<ToolSet, never>,
  atlasStream: StreamEmitter,
): Promise<{ response: string; metadata?: Record<string, unknown> }> {
  let fullText = "";
  const metadata: Record<string, unknown> = {};
  let currentStep = 0;

  // Process all events from fullStream
  for await (const event of aiResult.fullStream) {
    switch (event.type) {
      case "text": {
        fullText += event.text;
        atlasStream.emit({ type: "text", content: event.text });
        break;
      }

      case "reasoning": {
        atlasStream.emit({ type: "thinking", content: event.text });
        // Collect reasoning for metadata
        if (!metadata.reasoning) metadata.reasoning = "";
        metadata.reasoning += event.text;
        break;
      }

      case "tool-call": {
        atlasStream.emit({ type: "tool-call", toolName: event.toolName, args: event.input });
        break;
      }

      case "source": {
        // Map sources to custom events since Atlas doesn't have a direct source type
        atlasStream.emit({
          type: "custom",
          eventType: "source",
          data: { sourceType: event.sourceType, id: event.id, title: event.title },
        });
        break;
      }

      case "start-step": {
        currentStep++;
        atlasStream.emit({ type: "progress", message: `Starting step ${currentStep}` });
        break;
      }

      case "finish-step": {
        atlasStream.emit({ type: "progress", message: `Completed step ${currentStep}` });
        break;
      }

      case "start": {
        // Stream start - could emit progress but typically not needed
        // since Atlas stream is already active
        break;
      }

      case "finish": {
        // Handle finish event with reason and usage
        const finishReason = event.finishReason || "complete";

        // Emit usage if available in the finish event
        if (event.totalUsage) {
          atlasStream.emit({
            type: "usage",
            tokens: {
              input: event.totalUsage.inputTokens,
              output: event.totalUsage.outputTokens,
              total: event.totalUsage.totalTokens,
              cachedInput: event.totalUsage.cachedInputTokens,
            },
          });
          metadata.usage = event.totalUsage;
        }

        // Signal completion with reason
        atlasStream.emit({ type: "finish", reason: finishReason });
        break;
      }

      default: {
        // Handle any unknown event types as custom events
        atlasStream.emit({ type: "custom", eventType: event.type, data: event });
        break;
      }
    }
  }

  return { response: fullText, metadata: Object.keys(metadata).length > 0 ? metadata : undefined };
}
