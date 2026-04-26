/**
 * Factory that wraps a parent's {@link UIMessageStreamWriter} so every
 * child stream chunk is emitted inside a `nested-chunk` envelope keyed to
 * the parent's `toolCallId`.
 *
 * This lets the client reducer group child events under the parent tool
 * call instead of showing them as orphaned top-level calls.
 *
 * @module
 */

import type { UIMessageStreamWriter } from "ai";
import type { AtlasUIMessage, AtlasUIMessageChunk } from "./messages.ts";

/**
 * Creates a proxy writer that envelopes every chunk with the parent
 * tool call's ID before forwarding it to the underlying stream writer.
 *
 * Only `write()` is exposed — `merge()` is unnecessary because
 * `CallbackStreamEmitter` emits discrete events.
 */
export function createNestedChunkWriter(
  parentToolCallId: string,
  writer: UIMessageStreamWriter<AtlasUIMessage>,
): { write(chunk: AtlasUIMessageChunk): void } {
  return {
    write(chunk) {
      writer.write({
        type: "data-nested-chunk",
        data: { parentToolCallId, chunk },
      });
    },
  };
}
