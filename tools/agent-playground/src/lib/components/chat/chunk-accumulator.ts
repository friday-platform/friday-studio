/**
 * Pure accumulation module that folds an array of stream chunks
 * into a flat {@link Map} of {@link ToolCallDisplay} entries.
 *
 * This is the extracted, testable core of the chunk-reducer previously
 * embedded in {@link extractToolCalls}.  It knows nothing about message
 * structure, tree building, or reconciliation — it only handles state
 * transitions for individual tool calls.
 *
 * @module
 */

import type { ToolCallDisplay } from "./types.ts";

function stringOr<T>(value: unknown, fallback: T): string | T {
  return typeof value === "string" ? value : fallback;
}

/** Accumulator entry shape with optional parent tagging. */
type AccumulatedEntry = ToolCallDisplay & { parentToolCallId?: string };

/**
 * Apply a single chunk to the accumulator map.
 *
 * Unknown chunk types are silently ignored.  `tool-input-available`
 * creates a new entry if no prior `tool-input-start` was seen.
 * `tool-output-available` and `tool-output-error` are no-ops when the
 * entry is missing.
 */
function applyChunk(
  acc: Map<string, AccumulatedEntry>,
  chunk: unknown,
  parentToolCallId?: string,
): void {
  if (typeof chunk !== "object" || chunk === null || !("type" in chunk)) return;
  const type = chunk.type;
  if (typeof type !== "string") return;
  const toolCallId =
    "toolCallId" in chunk && typeof chunk.toolCallId === "string"
      ? chunk.toolCallId
      : undefined;
  if (!toolCallId) return;

  const stamp = parentToolCallId ? { parentToolCallId } : {};

  switch (type) {
    case "tool-input-start": {
      const toolName = "toolName" in chunk ? stringOr(chunk.toolName, "tool") : "tool";
      acc.set(toolCallId, {
        toolCallId,
        toolName,
        state: "input-streaming",
        input: undefined,
        ...stamp,
      });
      return;
    }
    case "tool-input-available": {
      const existing = acc.get(toolCallId);
      const toolName =
        "toolName" in chunk && typeof chunk.toolName === "string"
          ? chunk.toolName
          : (existing?.toolName ?? "tool");
      acc.set(toolCallId, {
        ...(existing ?? { toolCallId, toolName, state: "input-streaming" }),
        toolCallId,
        toolName,
        state: "input-available",
        input: "input" in chunk ? chunk.input : undefined,
        ...stamp,
      });
      return;
    }
    case "tool-output-available": {
      const existing = acc.get(toolCallId);
      if (!existing) return;
      acc.set(toolCallId, {
        ...existing,
        state: "output-available",
        output: "output" in chunk ? chunk.output : undefined,
        ...stamp,
      });
      return;
    }
    case "tool-output-error": {
      const existing = acc.get(toolCallId);
      if (!existing) return;
      acc.set(toolCallId, {
        ...existing,
        state: "output-error",
        errorText:
          "errorText" in chunk && typeof chunk.errorText === "string"
            ? chunk.errorText
            : existing.errorText,
        ...stamp,
      });
      return;
    }
    default:
      return;
  }
}

/**
 * Fold an array of UI message chunks into a flat map of tool-call display
 * entries keyed by `toolCallId`.
 *
 * @param chunks              Stream chunks in wire order.
 * @param parentToolCallId    When provided, every entry in the returned map
 *                            receives a `parentToolCallId` field with this
 *                            value — used by the delegate reconciler to tag
 *                            children with their parent delegate ID.
 * @returns Map preserving insertion order (wire order of first appearance).
 */
export function accumulateChunks(
  chunks: unknown[],
  parentToolCallId?: string,
): Map<string, AccumulatedEntry> {
  const acc = new Map<string, AccumulatedEntry>();
  for (const chunk of chunks) {
    applyChunk(acc, chunk, parentToolCallId);
  }
  return acc;
}
