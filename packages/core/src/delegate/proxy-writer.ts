/**
 * Proxy UIMessageStreamWriter for the delegate tool.
 *
 * Wraps every chunk written by a delegate's child sub-agent in a
 * `data-delegate-chunk` envelope before forwarding to the parent writer.
 * Inner chunks are forwarded unchanged — no `toolCallId` namespacing is
 * performed. `nested-chunk` envelopes from deeper inner agents pass through
 * transparently (they get double-wrapped in `delegate-chunk`).
 *
 * `finish` tool chunks are filtered out — the delegate consumes `finish` from
 * `result.toolResults` and does not surface it as a child tool call in the UI.
 *
 * Lifecycle:
 *   - `open`   — `write()` envelope-wraps and forwards; `merge(stream)` reads,
 *                envelope-wraps each chunk, and forwards to the parent.
 *   - `closed` — terminal. Late `write()` and `merge()` calls silently drop
 *                their input and emit one `logger.debug` per drop. Never
 *                throws. Set by the delegate's `finally` after `execute()`
 *                has emitted its terminator + ledger.
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
}

/**
 * Build a proxy writer that forwards envelope-wrapped chunks to the parent.
 */
export function createDelegateProxyWriter(deps: ProxyDeps): DelegateProxyWriter {
  const { parent, delegateToolCallId, logger } = deps;

  let lifecycle: "open" | "closed" = "open";
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

  const wrap = (chunk: AtlasUIMessageChunk): AtlasUIMessageChunk => {
    return { type: "data-delegate-chunk", data: { delegateToolCallId, chunk } };
  };

  const proxy: DelegateProxyWriter = {
    write(chunk) {
      if (lifecycle === "closed") {
        logger.debug("late write after delegate close", { delegateToolCallId });
        return;
      }
      if (shouldDrop(chunk)) {
        return;
      }
      parent.write(wrap(chunk));
    },

    merge(stream) {
      if (lifecycle === "closed") {
        logger.debug("late merge after delegate close", { delegateToolCallId });
        // Cancel the source so its producer doesn't leak on the floor.
        stream.cancel().catch(() => {});
        return;
      }
      const transformed = stream.pipeThrough(
        new TransformStream<AtlasUIMessageChunk, AtlasUIMessageChunk>({
          transform: (chunk, controller) => {
            if (shouldDrop(chunk)) return;
            controller.enqueue(wrap(chunk));
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
