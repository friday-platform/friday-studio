import type { AtlasUIMessageChunk, StreamEmitter } from "../types.ts";

/**
 * Pipes chunks from a Vercel AI SDK stream to an Atlas agent stream emitter.
 *
 * Used by conversation agents to stream LLM responses back to clients.
 * Reads chunks from the input stream and emits them through the agent SDK's
 * stream emitter until the stream is exhausted.
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
      atlasStreamEmitter.emit(value);
    }
  } finally {
    reader.releaseLock();
  }
}
