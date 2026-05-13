/**
 * Pure render helpers shared between the live chat UI and the chat export
 * route. Lifted out of `apps/studio-ui/.../user-chat.svelte` and
 * `chat-message-list.svelte` so the export route in `apps/atlasd` can call
 * them server-side and produce HTML that mirrors what the user saw.
 *
 * Helpers in this module never mutate their input message and never fall
 * back to `Date.now()` — empty timestamps render as empty strings, leaving
 * any "what time was that?" question to upstream callers.
 *
 * @module
 */

import type { AtlasUIMessage, MessageMetadata } from "@atlas/agent-sdk";
import { accumulateChunks } from "./chunk-accumulator.ts";
import { buildToolCallTree } from "./tree-builder.ts";
import type { ImageDisplay, Segment, ToolCallDisplay } from "./types.ts";

export type { ImageDisplay, Segment, ToolCallDisplay };

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
 * Type predicate that widens an unknown value to a plain
 * `Record<string, unknown>` for structural field probing. Lets the helpers
 * walk `msg.parts[]` defensively without the AI SDK discriminated union
 * narrowing every adjacent check into dead code.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
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
  const id =
    "parentToolCallId" in data && typeof data.parentToolCallId === "string"
      ? data.parentToolCallId
      : undefined;
  return id;
}

/**
 * Extract tool-call parts from an {@link AtlasUIMessage} in stream order,
 * reconstruct any nested delegate children, and reconcile their final
 * states using the `delegate-end` blanket rule.
 *
 * Two passes:
 *   1. First pass collects top-level tool calls from static `tool-<name>`
 *      parts and the `dynamic-tool` fallback, matching what the AI SDK's
 *      native stream processor emits into `msg.parts`.
 *   2. Second pass processes `data-delegate-chunk` and `data-nested-chunk`
 *      envelopes. Delegate envelopes are grouped by `delegateToolCallId`,
 *      unwrapped recursively (including any double-wrapped `nested-chunk`
 *      inside), and fed through {@link accumulateChunks} →
 *      {@link buildToolCallTree}. Top-level `data-nested-chunk` envelopes
 *      are accumulated directly with their `parentToolCallId`.
 *
 * `data-delegate-ledger` parts are intentionally filtered out — they exist
 * for a future reflection layer, not the UI tree. `durationMap` is scoped
 * by `delegateToolCallId` so multiple delegates with identically-named
 * children do not collide.
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
  const delegateText = new Map<string, string>();
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

    // Accumulate text response from the delegate agent's stream.
    if (
      typeof chunk === "object" &&
      chunk !== null &&
      "type" in chunk &&
      typeof chunk.type === "string" &&
      chunk.type === "text-delta" &&
      "delta" in chunk &&
      typeof chunk.delta === "string"
    ) {
      const prev = delegateText.get(delegateToolCallId) ?? "";
      delegateText.set(delegateToolCallId, prev + chunk.delta);
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
  const delegateFlats = new Map<
    string,
    Map<string, ToolCallDisplay & { parentToolCallId?: string }>
  >();
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
    const text = delegateText.get(delegateToolCallId);
    if (text && text.length > 0) {
      delegateTree.delegateText = text;
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
        "durationMs" in entry && typeof entry.durationMs === "number"
          ? entry.durationMs
          : undefined;
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

/**
 * Flatten a tree of {@link ToolCallDisplay} entries into a lookup map keyed
 * by `toolCallId`. Useful for chronological renderers that need to find
 * the enriched display (children, duration, reasoning, etc.) for a given
 * tool-call part while walking `msg.parts[]` in stream order.
 */
export function flattenToolCalls(calls: ToolCallDisplay[]): Map<string, ToolCallDisplay> {
  const map = new Map<string, ToolCallDisplay>();
  function walk(entries: ToolCallDisplay[]) {
    for (const entry of entries) {
      if (entry.toolCallId) {
        map.set(entry.toolCallId, entry);
      }
      if (entry.children && entry.children.length > 0) {
        walk(entry.children);
      }
    }
  }
  walk(calls);
  return map;
}

/**
 * Build chronological {@link Segment}s from an {@link AtlasUIMessage}'s
 * `parts[]` array. Consecutive text parts coalesce into a single `text`
 * segment; consecutive tool-call parts (and any reasoning that arrived
 * between them) group into a `tool-burst` segment. This preserves the
 * true stream order so the UI can render prose and tool activity exactly
 * where they happened.
 */
export function buildSegments(msg: AtlasUIMessage): Segment[] {
  if (!Array.isArray(msg.parts)) return [];
  const allToolCalls = extractToolCalls(msg);
  const toolMap = flattenToolCalls(allToolCalls);
  // Walk parts as opaque records — the AI SDK discriminated union narrows
  // each adjacent type check into dead code once we touch part.type.
  const parts: readonly unknown[] = msg.parts;

  const segments: Segment[] = [];
  let textBuffer = "";
  let toolBuffer: ToolCallDisplay[] = [];
  let reasoningBuffer = "";
  let burstIndex = 0;

  function flushText() {
    if (textBuffer.length > 0) {
      segments.push({ type: "text", content: textBuffer });
      textBuffer = "";
    }
  }

  function flushBurst() {
    if (toolBuffer.length > 0) {
      segments.push({
        type: "tool-burst",
        id: `${msg.id}-burst-${burstIndex++}`,
        calls: [...toolBuffer],
        reasoning: reasoningBuffer || undefined,
      });
      toolBuffer = [];
      reasoningBuffer = "";
    }
  }

  for (const part of parts) {
    if (!isRecord(part)) continue;
    if (typeof part.type !== "string") continue;
    const type = part.type;

    if (type === "text" && typeof part.text === "string") {
      flushBurst();
      textBuffer += part.text;
      continue;
    }

    if (type === "reasoning" || type === "reasoning-delta") {
      const delta =
        type === "reasoning"
          ? typeof part.text === "string"
            ? part.text
            : ""
          : typeof part.delta === "string"
            ? part.delta
            : "";
      if (toolBuffer.length > 0) {
        reasoningBuffer += delta;
      } else {
        textBuffer += delta;
      }
      continue;
    }

    if (type === "data-credential-linked") {
      if (isRecord(part.data) && typeof part.data.displayName === "string") {
        flushBurst();
        textBuffer += `Connected ${part.data.displayName}.`;
      }
      continue;
    }

    const isTool = type.startsWith("tool-") || type === "dynamic-tool";
    if (isTool) {
      const toolCallId = typeof part.toolCallId === "string" ? part.toolCallId : "";
      const display = toolMap.get(toolCallId);
      if (display) {
        flushText();
        toolBuffer.push(display);
      }
    }
  }

  flushText();
  flushBurst();
  return segments;
}

/**
 * Extract image parts from an {@link AtlasUIMessage}. Only `file` parts
 * with a `mediaType` starting with `image/` (or no mediaType — defaults
 * to `image/png`) are returned. Other file types are ignored.
 */
export function extractImages(msg: AtlasUIMessage): ImageDisplay[] {
  if (!Array.isArray(msg.parts)) return [];
  const imgs: ImageDisplay[] = [];
  for (const part of msg.parts) {
    if (typeof part !== "object" || part === null || !("type" in part)) continue;
    if (part.type !== "file") continue;
    if (!("url" in part) || typeof part.url !== "string") continue;
    const mediaType =
      "mediaType" in part && typeof part.mediaType === "string" ? part.mediaType : "image/png";
    if (!mediaType.startsWith("image/")) continue;
    const filename =
      "filename" in part && typeof part.filename === "string" ? part.filename : undefined;
    imgs.push({ url: part.url, mediaType, filename });
  }
  return imgs;
}

const DATETIME_FMT = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

/**
 * Format a message's metadata timestamp for display in the per-message
 * "…" menu. Reads `startTimestamp || timestamp || endTimestamp` in that
 * order. Returns the empty string when no timestamp is present or when
 * the value isn't a parseable ISO date — no `Date.now()` fallback, no
 * borrowing from neighbors, no "Today, …" prefix.
 *
 * Always includes the date (e.g. `Apr 20, 11:31 PM`). The export is a
 * snapshot of the sender's session, so a recipient opening it on a
 * different day or in a different timezone still sees an unambiguous
 * date — no same-day shortcut that hides it.
 */
export function formatMessageTimestamp(metadata: MessageMetadata | undefined): string {
  const iso = metadata?.startTimestamp ?? metadata?.timestamp ?? metadata?.endTimestamp;
  if (typeof iso !== "string" || iso.length === 0) return "";
  const ms = new Date(iso).getTime();
  if (Number.isNaN(ms)) return "";
  return DATETIME_FMT.format(new Date(ms));
}
