/**
 * Proxy UIMessageStreamWriter for the delegate tool.
 *
 * Wraps every chunk written by a delegate's child sub-agent in a
 * `data-delegate-chunk` envelope before forwarding to the parent writer.
 * Namespaces any embedded `toolCallId` field as
 * `${delegateToolCallId}-${childToolCallId}` to prevent collisions with
 * sibling tool calls under the parent.
 *
 * `finish` tool chunks are filtered out — the delegate consumes `finish` from
 * `result.toolResults` and does not surface it as a child tool call in the UI.
 *
 * Lifecycle (three states):
 *   - `open`     — `write()` envelope-wraps and forwards; `merge(stream)` reads,
 *                  envelope-wraps each chunk, and forwards to the parent.
 *   - `merging`  — internal state while at least one `merge(stream)` call is
 *                  still draining its source. `write()` is still permitted.
 *   - `closed`   — terminal. Late `write()` and `merge()` calls silently drop
 *                  their input and emit one `logger.debug` per drop. Never
 *                  throws. Set by the delegate's `finally` after `execute()`
 *                  has emitted its terminator + ledger.
 */

import type { AtlasUIMessage, AtlasUIMessageChunk } from "@atlas/agent-sdk";
import type { Logger } from "@atlas/logger";
import type { UIMessageStreamWriter } from "ai";

const FINISH_TOOL_NAME = "finish";

interface ProxyDeps {
  parent: UIMessageStreamWriter<AtlasUIMessage>;
  delegateToolCallId: string;
  logger: Logger;
}

export interface DelegateProxyWriter extends UIMessageStreamWriter<AtlasUIMessage> {
  /** Transition to the terminal `closed` state. Idempotent. */
  close(): void;
  /** For tests / diagnostics. */
  readonly state: "open" | "merging" | "closed";
}

/**
 * Build a proxy writer that forwards envelope-wrapped chunks to the parent.
 */
export function createDelegateProxyWriter(deps: ProxyDeps): DelegateProxyWriter {
  const { parent, delegateToolCallId, logger } = deps;

  let lifecycle: "open" | "closed" = "open";
  let activeMerges = 0;
  const finishToolCallIds = new Set<string>();

  const shouldDrop = (chunk: AtlasUIMessageChunk): boolean => {
    if (typeof chunk !== "object" || chunk === null || !("type" in chunk)) {
      return false;
    }
    if ("toolName" in chunk && chunk.toolName === FINISH_TOOL_NAME && "toolCallId" in chunk) {
      finishToolCallIds.add(chunk.toolCallId);
      return true;
    }
    if ("toolCallId" in chunk && finishToolCallIds.has(chunk.toolCallId)) {
      return true;
    }
    return false;
  };

  const namespaceAndWrap = (chunk: AtlasUIMessageChunk): AtlasUIMessageChunk => {
    let outChunk: AtlasUIMessageChunk = chunk;
    if (
      typeof chunk === "object" &&
      chunk !== null &&
      "toolCallId" in chunk &&
      typeof chunk.toolCallId === "string"
    ) {
      outChunk = {
        ...chunk,
        toolCallId: `${delegateToolCallId}-${chunk.toolCallId}`,
      } as AtlasUIMessageChunk;
    }
    // Data events (e.g. data-tool-timing) may carry the toolCallId inside
    // `data` rather than at the chunk top level — namespace those too.
    if (
      typeof outChunk === "object" &&
      outChunk !== null &&
      "data" in outChunk &&
      typeof outChunk.data === "object" &&
      outChunk.data !== null &&
      "toolCallId" in outChunk.data &&
      typeof outChunk.data.toolCallId === "string"
    ) {
      outChunk = {
        ...outChunk,
        data: { ...outChunk.data, toolCallId: `${delegateToolCallId}-${outChunk.data.toolCallId}` },
      } as AtlasUIMessageChunk;
    }
    return { type: "data-delegate-chunk", data: { delegateToolCallId, chunk: outChunk } };
  };

  const proxy: DelegateProxyWriter = {
    get state() {
      if (lifecycle === "closed") return "closed";
      return activeMerges > 0 ? "merging" : "open";
    },

    write(chunk) {
      if (lifecycle === "closed") {
        logger.debug("late write after delegate close", { delegateToolCallId });
        return;
      }
      if (shouldDrop(chunk)) {
        return;
      }
      parent.write(namespaceAndWrap(chunk));
    },

    merge(stream) {
      if (lifecycle === "closed") {
        logger.debug("late merge after delegate close", { delegateToolCallId });
        // Cancel the source so its producer doesn't leak on the floor.
        stream.cancel().catch(() => {});
        return;
      }
      activeMerges++;
      const transformed = stream.pipeThrough(
        new TransformStream<AtlasUIMessageChunk, AtlasUIMessageChunk>({
          transform: (chunk, controller) => {
            if (shouldDrop(chunk)) return;
            controller.enqueue(namespaceAndWrap(chunk));
          },
          flush: () => {
            activeMerges--;
          },
        }),
      );
      parent.merge(transformed);
    },

    onError: parent.onError,

    close() {
      lifecycle = "closed";
    },
  };

  return proxy;
}
