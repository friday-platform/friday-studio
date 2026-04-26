/**
 * Reducer that flattens an {@link AtlasUIMessage}'s `parts` array into a
 * tree of {@link ToolCallDisplay} entries for the chat UI.
 *
 * Two passes:
 *   1. First pass collects top-level tool calls from static `tool-<name>`
 *      parts and the `dynamic-tool` fallback, matching what the AI SDK's
 *      native stream processor emits into `msg.parts`.
 *   2. Second pass processes `data-delegate-chunk` and `data-nested-chunk`
 *      envelopes.  Delegate envelopes are grouped by `delegateToolCallId`,
 *      unwrapped recursively (including any double-wrapped `nested-chunk`
 *      inside), and fed through {@link accumulateChunks} →
 *      {@link buildToolCallTree}.  Top-level `data-nested-chunk` envelopes
 *      are accumulated directly with their `parentToolCallId`.
 *
 * After grouping, a single reconciliation rule finalises the tree:
 *   - **`delegate-end` blanket sentinel:** if a delegate's synthetic
 *     `{ type: "delegate-end" }` chunk is present, every child under that
 *     delegate still in a non-terminal state is promoted to `output-error`
 *     with `errorText: "interrupted"`.  Terminal children are never
 *     clobbered.
 *
 * `data-delegate-ledger` parts are intentionally filtered out — they exist
 * for a future reflection layer, not the UI tree.  `durationMap` is scoped
 * by `delegateToolCallId` so multiple delegates with identically-named
 * children do not collide.
 *
 * @module
 */

import type { AtlasUIMessage } from "@atlas/agent-sdk";
import { accumulateChunks } from "./chunk-accumulator.ts";
import { buildToolCallTree } from "./tree-builder.ts";
import type { ToolCallDisplay } from "./types.ts";

const TOOL_CALL_STATES = [
  "input-streaming",
  "input-available",
  "approval-requested",
  "approval-responded",
  "output-available",
  "output-error",
  "output-denied",
] as const;

function toToolCallState(value: unknown): ToolCallDisplay["state"] {
  if (typeof value !== "string") return "input-streaming";
  for (const s of TOOL_CALL_STATES) {
    if (s === value) return s;
  }
  return "input-streaming";
}

function stringOr<T>(value: unknown, fallback: T): string | T {
  return typeof value === "string" ? value : fallback;
}

/**
 * Extract a top-level {@link ToolCallDisplay} from a single tool part, or
 * `null` if the part isn't a recognizable tool shape.
 */
function toDisplayFromToolPart(part: unknown): ToolCallDisplay | null {
  if (typeof part !== "object" || part === null || !("type" in part)) return null;
  const type = part.type;
  if (typeof type !== "string") return null;

  const isStatic = type.startsWith("tool-");
  const isDynamic = type === "dynamic-tool";
  if (!isStatic && !isDynamic) return null;

  const toolCallId =
    "toolCallId" in part && typeof part.toolCallId === "string" ? part.toolCallId : "";
  const toolName = isDynamic
    ? "toolName" in part
      ? stringOr(part.toolName, "tool")
      : "tool"
    : type.slice("tool-".length);

  return {
    toolCallId,
    toolName,
    state: "state" in part ? toToolCallState(part.state) : "input-streaming",
    input: "input" in part ? part.input : undefined,
    output: "output" in part ? part.output : undefined,
    errorText:
      "errorText" in part && typeof part.errorText === "string" ? part.errorText : undefined,
  };
}

/**
 * Children whose state is irreversibly resolved. The `delegate-end` blanket
 * rule never overwrites these.
 */
const TERMINAL_CHILD_STATES = new Set<ToolCallDisplay["state"]>([
  "output-available",
  "output-error",
  "output-denied",
]);

/**
 * Promote a non-terminal child to `output-error` with `errorText: "interrupted"`.
 * No-op if the child is already terminal.
 */
function interruptChild(child: ToolCallDisplay): void {
  if (TERMINAL_CHILD_STATES.has(child.state)) return;
  child.state = "output-error";
  child.errorText = "interrupted";
}

/**
 * Recursively interrupt a child and every descendant.
 */
function interruptSubtree(child: ToolCallDisplay): void {
  interruptChild(child);
  if (child.children) {
    for (const c of child.children) interruptSubtree(c);
  }
}

/**
 * Read a `parentToolCallId` from a `data-nested-chunk` envelope payload
 * defensively. Returns `undefined` when the shape is malformed.
 */
function readNestedParentId(data: unknown): string | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const id = "parentToolCallId" in data && typeof data.parentToolCallId === "string"
    ? data.parentToolCallId
    : undefined;
  return id;
}

/**
 * Extract tool-call parts from an {@link AtlasUIMessage} in stream order,
 * reconstruct any nested delegate children, and reconcile their final
 * states using the `delegate-end` blanket rule.
 *
 * See module doc for pass semantics. `data-delegate-ledger` parts are
 * silently dropped — they surface via a separate reflection-layer path.
 */
export function extractToolCalls(msg: AtlasUIMessage): ToolCallDisplay[] {
  if (!Array.isArray(msg.parts)) return [];

  // Pass 1: flat top-level tool calls.
  const calls: ToolCallDisplay[] = [];
  const byToolCallId = new Map<string, ToolCallDisplay>();
  for (const part of msg.parts) {
    const display = toDisplayFromToolPart(part);
    if (!display) continue;
    calls.push(display);
    if (display.toolCallId) byToolCallId.set(display.toolCallId, display);
  }

  // Pass 2: collect raw chunks from data-delegate-chunk and data-nested-chunk
  // into per-parent arrays, then run accumulateChunks once per group.

  // Top-level nested-chunk chunks grouped by parentToolCallId.
  const nestedChunksByParent = new Map<string, unknown[]>();

  // Delegate-chunk chunks grouped by (delegateToolCallId → parentToolCallId → chunks).
  // Raw tool chunks are keyed under the delegate itself; nested-chunk unwraps
  // are keyed under their inner parentToolCallId so accumulateChunks stamps
  // the correct parent.
  const delegateChunksByParent = new Map<string, Map<string, unknown[]>>();

  // Per-delegate metadata collected during the sweep.
  const delegateReasoning = new Map<string, string>();
  const delegateProgress = new Map<string, string[]>();
  const delegateTerminated = new Set<string>();

  for (const part of msg.parts) {
    if (typeof part !== "object" || part === null || !("type" in part)) continue;

    // --- Top-level nested-chunk (direct agent calls) ---
    if (part.type === "data-nested-chunk") {
      if (!("data" in part) || typeof part.data !== "object" || part.data === null) continue;
      const parentToolCallId = readNestedParentId(part.data);
      if (!parentToolCallId) continue;
      const chunk = "chunk" in part.data ? part.data.chunk : undefined;
      if (chunk === undefined) continue;

      const list = nestedChunksByParent.get(parentToolCallId);
      if (list) {
        list.push(chunk);
      } else {
        nestedChunksByParent.set(parentToolCallId, [chunk]);
      }
      continue;
    }

    // --- Delegate-chunk (only delegates accepted from here) ---
    if (part.type !== "data-delegate-chunk") continue;
    if (!("data" in part) || typeof part.data !== "object" || part.data === null) continue;
    const delegateToolCallId =
      "delegateToolCallId" in part.data && typeof part.data.delegateToolCallId === "string"
        ? part.data.delegateToolCallId
        : undefined;
    if (!delegateToolCallId) continue;

    // Skip orphans: envelope with no matching top-level delegate entry.
    const parent = byToolCallId.get(delegateToolCallId);
    if (!parent || parent.toolName !== "delegate") continue;

    const chunk = "chunk" in part.data ? part.data.chunk : undefined;
    if (chunk === undefined) continue;

    // Sentinel: delegate-end is a blanket terminator for this delegate.
    if (
      typeof chunk === "object" &&
      chunk !== null &&
      "type" in chunk &&
      chunk.type === "delegate-end"
    ) {
      delegateTerminated.add(delegateToolCallId);
      continue;
    }

    // Accumulate reasoning deltas on the delegate entry itself.
    if (
      typeof chunk === "object" &&
      chunk !== null &&
      "type" in chunk &&
      typeof chunk.type === "string" &&
      chunk.type === "reasoning-delta" &&
      "delta" in chunk &&
      typeof chunk.delta === "string"
    ) {
      const prev = delegateReasoning.get(delegateToolCallId) ?? "";
      delegateReasoning.set(delegateToolCallId, prev + chunk.delta);
      continue;
    }

    // Accumulate progress lines on the delegate entry itself.
    if (
      typeof chunk === "object" &&
      chunk !== null &&
      "type" in chunk &&
      typeof chunk.type === "string" &&
      chunk.type === "data-tool-progress" &&
      "data" in chunk &&
      typeof chunk.data === "object" &&
      chunk.data !== null &&
      "content" in chunk.data &&
      typeof chunk.data.content === "string"
    ) {
      const list = delegateProgress.get(delegateToolCallId) ?? [];
      list.push(chunk.data.content);
      delegateProgress.set(delegateToolCallId, list);
      continue;
    }

    // Unwrap nested-chunk envelopes inside delegate-chunk recursively.
    if (
      typeof chunk === "object" &&
      chunk !== null &&
      "type" in chunk &&
      chunk.type === "data-nested-chunk"
    ) {
      if (!("data" in chunk) || typeof chunk.data !== "object" || chunk.data === null) continue;
      const nestedParentId = readNestedParentId(chunk.data);
      const innerChunk = "chunk" in chunk.data ? chunk.data.chunk : undefined;
      if (nestedParentId && innerChunk !== undefined) {
        let parentMap = delegateChunksByParent.get(delegateToolCallId);
        if (!parentMap) {
          parentMap = new Map();
          delegateChunksByParent.set(delegateToolCallId, parentMap);
        }
        const list = parentMap.get(nestedParentId);
        if (list) {
          list.push(innerChunk);
        } else {
          parentMap.set(nestedParentId, [innerChunk]);
        }
      }
      continue;
    }

    // Raw tool chunk — direct child of the delegate.
    let parentMap = delegateChunksByParent.get(delegateToolCallId);
    if (!parentMap) {
      parentMap = new Map();
      delegateChunksByParent.set(delegateToolCallId, parentMap);
    }
    const list = parentMap.get(delegateToolCallId);
    if (list) {
      list.push(chunk);
    } else {
      parentMap.set(delegateToolCallId, [chunk]);
    }
  }

  // Pass 3a: Accumulate top-level nested-chunk groups.
  const nestedFlat = new Map<string, ToolCallDisplay & { parentToolCallId?: string }>();
  for (const [parentToolCallId, chunks] of nestedChunksByParent) {
    const acc = accumulateChunks(chunks, parentToolCallId);
    for (const [k, v] of acc) {
      nestedFlat.set(k, v);
    }
  }

  // Pass 3b: Accumulate per-delegate / per-parent groups.
  const delegateFlats = new Map<string, Map<string, ToolCallDisplay & { parentToolCallId?: string }>>();
  for (const [delegateToolCallId, parentMap] of delegateChunksByParent) {
    const flat = new Map<string, ToolCallDisplay & { parentToolCallId?: string }>();
    for (const [parentToolCallId, chunks] of parentMap) {
      const acc = accumulateChunks(chunks, parentToolCallId);
      for (const [k, v] of acc) {
        flat.set(k, v);
      }
    }
    delegateFlats.set(delegateToolCallId, flat);
  }

  // Build global tree from Pass 1 entries + top-level nested-chunk children.
  const globalFlat = new Map<string, ToolCallDisplay & { parentToolCallId?: string }>();
  for (const call of calls) {
    globalFlat.set(call.toolCallId, { ...call, parentToolCallId: undefined });
  }
  for (const [k, v] of nestedFlat) {
    if (!globalFlat.has(k)) {
      globalFlat.set(k, v);
    }
  }
  const trees = buildToolCallTree(globalFlat);

  // Pass 3c: Build per-delegate subtrees and attach to the matching delegate roots.
  for (const [delegateToolCallId, flat] of delegateFlats) {
    const delegateTree = trees.find((t) => t.toolCallId === delegateToolCallId);
    if (!delegateTree) continue;

    delegateTree.children = buildToolCallTree(flat);

    const reasoning = delegateReasoning.get(delegateToolCallId);
    if (reasoning && reasoning.length > 0) {
      delegateTree.reasoning = reasoning;
    }
    const progress = delegateProgress.get(delegateToolCallId);
    if (progress && progress.length > 0) {
      delegateTree.progress = progress;
    }
  }

  // Pass 3d: Collect `data-delegate-ledger` durations scoped per delegate.
  const durationMap = new Map<string, Map<string, number>>();
  for (const part of msg.parts) {
    if (typeof part !== "object" || part === null || !("type" in part)) continue;
    if (part.type !== "data-delegate-ledger") continue;
    if (!("data" in part) || typeof part.data !== "object" || part.data === null) continue;
    const dId =
      "delegateToolCallId" in part.data && typeof part.data.delegateToolCallId === "string"
        ? part.data.delegateToolCallId
        : "";
    const toolsUsed =
      "toolsUsed" in part.data && Array.isArray(part.data.toolsUsed) ? part.data.toolsUsed : [];
    for (const entry of toolsUsed) {
      if (typeof entry !== "object" || entry === null) continue;
      const childId =
        "toolCallId" in entry && typeof entry.toolCallId === "string" ? entry.toolCallId : "";
      const dur =
        "durationMs" in entry && typeof entry.durationMs === "number" ? entry.durationMs : undefined;
      if (dId && childId && dur !== undefined && dur > 0) {
        let innerMap = durationMap.get(dId);
        if (!innerMap) {
          innerMap = new Map();
          durationMap.set(dId, innerMap);
        }
        innerMap.set(childId, dur);
      }
    }
  }

  // Walk every delegate subtree and stamp scoped durations + apply delegate-end.
  function walkAndFinalize(entries: ToolCallDisplay[], delegateId: string): void {
    for (const entry of entries) {
      const innerMap = durationMap.get(delegateId);
      if (!entry.durationMs && innerMap?.has(entry.toolCallId)) {
        entry.durationMs = innerMap.get(entry.toolCallId);
      }
      if (delegateTerminated.has(delegateId)) {
        interruptSubtree(entry);
      }
      if (entry.children && entry.children.length > 0) {
        walkAndFinalize(entry.children, delegateId);
      }
    }
  }

  for (const tree of trees) {
    const isDelegate = byToolCallId.has(tree.toolCallId) && tree.toolName === "delegate";
    if (isDelegate && tree.children) {
      walkAndFinalize(tree.children, tree.toolCallId);
    }
  }

  return trees;
}
