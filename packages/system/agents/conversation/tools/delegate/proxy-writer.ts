/**
 * Proxy UIMessageStreamWriter for the delegate tool.
 *
 * Wraps every chunk written by a delegate's child sub-agent in a
 * `data-delegate-chunk` envelope before forwarding to the parent writer.
 * Namespaces any embedded `toolCallId` field as
 * `${delegateToolCallId}::${childToolCallId}` to prevent collisions with
 * sibling tool calls under the parent.
 *
 * `finish` tool chunks are filtered out — the delegate consumes `finish` from
 * `result.toolResults` and does not surface it as a child tool call in the UI.
 *
 * Lifecycle: opens in "open" state. After the delegate's `execute()` returns,
 * the delegate calls `close()`, which transitions the proxy to "closed".
 * Late writes in the closed state are silently dropped (debug-logged).
 * Task #6 will extend this with a `delegate-end` terminator and ledger
 * emission inside the close transition.
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
  close(): void;
}

/**
 * Build a proxy writer that forwards envelope-wrapped chunks to the parent.
 */
export function createDelegateProxyWriter(deps: ProxyDeps): DelegateProxyWriter {
  const { parent, delegateToolCallId, logger } = deps;

  let state: "open" | "closed" = "open";
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
        toolCallId: `${delegateToolCallId}::${chunk.toolCallId}`,
      } as AtlasUIMessageChunk;
    }
    return { type: "data-delegate-chunk", data: { delegateToolCallId, chunk: outChunk } };
  };

  const proxy: DelegateProxyWriter = {
    write(chunk) {
      if (state === "closed") {
        logger.debug("delegate proxy writer received write after close", { delegateToolCallId });
        return;
      }
      if (shouldDrop(chunk)) {
        return;
      }
      parent.write(namespaceAndWrap(chunk));
    },

    merge(stream) {
      if (state === "closed") {
        logger.debug("delegate proxy writer received merge after close", { delegateToolCallId });
        return;
      }
      const transformed = stream.pipeThrough(
        new TransformStream<AtlasUIMessageChunk, AtlasUIMessageChunk>({
          transform: (chunk, controller) => {
            if (shouldDrop(chunk)) return;
            controller.enqueue(namespaceAndWrap(chunk));
          },
        }),
      );
      parent.merge(transformed);
    },

    onError: parent.onError,

    close() {
      state = "closed";
    },
  };

  return proxy;
}
