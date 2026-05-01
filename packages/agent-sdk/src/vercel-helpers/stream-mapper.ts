import type { AtlasUIMessageChunk, StreamEmitter } from "../types.ts";

/**
 * Decode literal \uXXXX sequences that leak from JSON-encoded model output.
 * Only handles Basic Multilingual Plane escapes (\uNNNN) — no surrogates.
 */
export function decodeUnicodeEscapes(text: string): string {
  return text.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) =>
    String.fromCharCode(parseInt(hex, 16)),
  );
}

/**
 * Pipes chunks from a Vercel AI SDK stream to an Atlas agent stream emitter.
 *
 * Used by conversation agents to stream LLM responses back to clients.
 * Reads chunks from the input stream and emits them through the agent SDK's
 * stream emitter until the stream is exhausted.
 *
 * Decodes literal \uXXXX escape sequences in text-delta chunks so they
 * render as actual characters instead of visible escape strings.
 *
 * @param stream - ReadableStream from Vercel AI SDK's toUIMessageStream()
 * @param emitter - Atlas agent SDK stream emitter for sending chunks to clients
 *
 * @example
 * // In a conversation agent handler:
 * const result = streamText({ model, messages, ... });
 * await pipeUIMessageStream(
 *   result.toUIMessageStream({ ... }),
 *   stream  // from agent context
 * );
 */
export async function pipeUIMessageStream(
  uiMessageStream: ReadableStream<AtlasUIMessageChunk>,
  atlasStreamEmitter?: StreamEmitter,
): Promise<void> {
  // this is a hack to prevent emitting chunks for cron/non-ui-driven
  // sessions.
  if (!atlasStreamEmitter) return;
  const reader = uiMessageStream.getReader();
  try {
    // Read chunks until stream ends
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      // Decode unicode escapes leaked from JSON-encoded tool arguments
      if (value.type === "text-delta" && "delta" in value) {
        const decoded = decodeUnicodeEscapes(value.delta);
        if (decoded !== value.delta) {
          atlasStreamEmitter.emit({ ...value, delta: decoded });
          continue;
        }
      }

      atlasStreamEmitter.emit(value);
    }
  } finally {
    reader.releaseLock();
  }
}
