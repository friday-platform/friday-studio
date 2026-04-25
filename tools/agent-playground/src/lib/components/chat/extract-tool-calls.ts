/**
 * Reducer that flattens an {@link AtlasUIMessage}'s `parts` array into a
 * tree of {@link ToolCallDisplay} entries for the chat UI.
 *
 * Two passes:
 *   1. First pass collects top-level tool calls from static `tool-<name>`
 *      parts and the `dynamic-tool` fallback, matching what the AI SDK's
 *      native stream processor emits into `msg.parts`.
 *   2. Second pass groups `data-delegate-chunk` envelopes by
 *      `data.delegateToolCallId`, runs a small accumulator over each
 *      group's wrapped chunks to reconstruct child `ToolCallDisplay`
 *      entries, and attaches them to the matching top-level delegate
 *      entry's `children` field.
 *
 * After grouping, two reconciliation rules finalize the tree (Task #7):
 *   - **`delegate-end` terminator (authoritative):** if the proxy writer's
 *     synthetic `{ type: "delegate-end", pendingToolCallIds }` chunk is
 *     present for a delegate, every listed (namespaced) child still in a
 *     non-terminal state is promoted to `output-error` with
 *     `errorText: "interrupted"`. Terminal children are never clobbered.
 *   - **`parent.state === "done"` crash fallback:** if the parent message
 *     reached its terminal lifecycle state but no `delegate-end` arrived
 *     for a given delegate (catastrophic crash before the server-side
 *     `finally` could write the terminator), every still-in-progress child
 *     under that delegate is promoted to `output-error` with
 *     `errorText: "interrupted"`. Only applies to delegates without an
 *     explicit terminator — the rule never overrides `delegate-end`.
 *
 * `data-delegate-ledger` parts are intentionally filtered out — they exist
 * for a future reflection layer, not the UI tree.
 *
 * @module
 */

import type { AtlasUIMessage } from "@atlas/agent-sdk";
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
 * State-transition accumulator for child tool calls reconstructed from
 * `data-delegate-chunk` envelopes. Mirrors the shape AI SDK's native
 * stream processor uses when folding `tool-input-start` →
 * `tool-input-available` → `tool-output-available`/`tool-output-error`
 * into `msg.parts` entries.
 *
 * Keyed by (namespaced) `toolCallId`. Insertion order preserved so the
 * rendered children mirror wire order.
 */
type ChildAccumulator = Map<string, ToolCallDisplay>;

/**
 * Apply a single wrapped chunk to the child accumulator.
 *
 * Unknown chunk types are ignored — only the state-transition chunks
 * touch the `ToolCallDisplay` shape. `finish` chunks are dropped upstream
 * by the proxy writer, so we don't need to filter them here.
 *
 * IDs may be multi-segment (`delegate-agent-fetch`) when bundled
 * agents namespace their inner tool calls. The accumulator is flat
 * (keyed by the full namespaced string); tree construction happens
 * afterwards in {@link buildNestedChildren}.
 */
function applyChunk(acc: ChildAccumulator, chunk: unknown): void {
  if (typeof chunk !== "object" || chunk === null || !("type" in chunk)) return;
  const type = chunk.type;
  if (typeof type !== "string") return;
  const toolCallId =
    "toolCallId" in chunk && typeof chunk.toolCallId === "string" ? chunk.toolCallId : undefined;
  if (!toolCallId) return;

  switch (type) {
    case "tool-input-start": {
      const toolName = "toolName" in chunk ? stringOr(chunk.toolName, "tool") : "tool";
      acc.set(toolCallId, {
        toolCallId,
        toolName,
        state: "input-streaming",
        input: undefined,
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
      });
      return;
    }
    default:
      return;
  }
}

/**
 * Children whose state is irreversibly resolved. The reconciliation rules
 * never overwrite these — both the explicit `delegate-end` terminator and
 * the `parent.state === "done"` fallback are last-write-wins safety nets,
 * not authority over actual outcome chunks.
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
 * Used when a parent is listed in `delegate-end.pendingToolCallIds`
 * — its inner tools were also cut short.
 */
function interruptSubtree(child: ToolCallDisplay): void {
  interruptChild(child);
  if (child.children) {
    for (const c of child.children) interruptSubtree(c);
  }
}

/**
 * Build a tree of `ToolCallDisplay` entries from a flat accumulator of
 * namespaced `toolCallId`s.
 *
 * An entry `parentId-childId` is a direct child of `parentId`.
 * An entry `parentId-childId-grandchildId` is a direct child of
 * `parentId-childId`. This recurses so the UI can render arbitrary
 * nesting depth (e.g. delegate → agent_web → fetch).
 *
 * Orphaned descendants whose intermediate parent is missing in the flat
 * map are promoted to direct children so nothing is silently dropped.
 */
function buildNestedChildren(
  flat: Map<string, ToolCallDisplay>,
  parentId: string,
): ToolCallDisplay[] {
  const prefix = `${parentId}-`;
  const children: ToolCallDisplay[] = [];

  for (const [id, display] of flat) {
    if (!id.startsWith(prefix)) continue;
    const suffix = id.slice(prefix.length);
    if (suffix.includes("-")) continue; // not a direct child — recurse below
    const nested = buildNestedChildren(flat, id);
    children.push(nested.length > 0 ? { ...display, children: nested } : display);
  }

  return children;
}

/**
 * Read the parent message's lifecycle state. AI SDK v6's `UIMessage` does
 * not type a top-level `state` field, but downstream layers (chat
 * persistence, hand-built crash-test fixtures) may stamp one — we read
 * defensively. Returns `true` only when the message has explicitly
 * reached its terminal turn.
 */
function isMessageDone(msg: AtlasUIMessage): boolean {
  if (typeof msg !== "object" || msg === null) return false;
  if (!("state" in msg)) return false;
  const state = (msg as { state?: unknown }).state;
  return state === "done";
}

/**
 * Extract tool-call parts from an {@link AtlasUIMessage} in stream order,
 * reconstruct any nested delegate children, and reconcile their final
 * states using the `delegate-end` terminator and `parent.state === "done"`
 * crash fallback rules.
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

  // Pass 2: group `data-delegate-chunk` envelopes by `delegateToolCallId`.
  // `delegate-end` chunks are routed to a separate map (the terminator
  // rule operates on them, not the per-child accumulator).
  const grouped = new Map<string, ChildAccumulator>();
  const delegateEndPending = new Map<string, string[]>();
  // Per-delegate ephemeral accumulators: reasoning text and progress lines.
  const delegateReasoning = new Map<string, string>();
  const delegateProgress = new Map<string, string[]>();
  for (const part of msg.parts) {
    if (typeof part !== "object" || part === null || !("type" in part)) continue;
    if (part.type !== "data-delegate-chunk") continue;
    if (!("data" in part) || typeof part.data !== "object" || part.data === null) continue;
    if (!("delegateToolCallId" in part.data) || typeof part.data.delegateToolCallId !== "string") {
      continue;
    }
    const delegateToolCallId = part.data.delegateToolCallId;
    // Skip orphans: envelope with no matching top-level delegate entry.
    const parent = byToolCallId.get(delegateToolCallId);
    if (!parent || parent.toolName !== "delegate") continue;
    let acc = grouped.get(delegateToolCallId);
    if (!acc) {
      acc = new Map();
      grouped.set(delegateToolCallId, acc);
    }
    const chunk = "chunk" in part.data ? part.data.chunk : undefined;
    if (
      typeof chunk === "object" &&
      chunk !== null &&
      "type" in chunk &&
      chunk.type === "delegate-end"
    ) {
      // Malformed terminators (missing or non-array `pendingToolCallIds`)
      // are dropped entirely — better to fall through to the
      // `parent.state === "done"` rule than to falsely register a
      // valid-but-empty terminator that suppresses it.
      if ("pendingToolCallIds" in chunk && Array.isArray(chunk.pendingToolCallIds)) {
        const pending = chunk.pendingToolCallIds.filter(
          (id): id is string => typeof id === "string",
        );
        delegateEndPending.set(delegateToolCallId, pending);
      }
      continue;
    }
    // Accumulate reasoning deltas, progress events, and tool timings
    // alongside tool chunks.
    if (
      typeof chunk === "object" &&
      chunk !== null &&
      "type" in chunk &&
      typeof chunk.type === "string"
    ) {
      if (chunk.type === "reasoning-delta" && "delta" in chunk && typeof chunk.delta === "string") {
        const prev = delegateReasoning.get(delegateToolCallId) ?? "";
        delegateReasoning.set(delegateToolCallId, prev + chunk.delta);
        continue;
      }
      if (
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
      if (
        chunk.type === "data-tool-timing" &&
        "data" in chunk &&
        typeof chunk.data === "object" &&
        chunk.data !== null &&
        "toolCallId" in chunk.data &&
        typeof chunk.data.toolCallId === "string" &&
        "durationMs" in chunk.data &&
        typeof chunk.data.durationMs === "number"
      ) {
        const existing = acc.get(chunk.data.toolCallId);
        if (existing) {
          existing.durationMs = chunk.data.durationMs;
        }
        continue;
      }
    }
    applyChunk(acc, chunk);
  }

  // Attach reconstructed children, reasoning, and progress to their parent
  // delegate entries.
  for (const [delegateToolCallId, acc] of grouped) {
    const parent = byToolCallId.get(delegateToolCallId);
    if (!parent) continue;
    parent.children = buildNestedChildren(acc, delegateToolCallId);
    const reasoning = delegateReasoning.get(delegateToolCallId);
    if (reasoning && reasoning.length > 0) {
      parent.reasoning = reasoning;
    }
    const progress = delegateProgress.get(delegateToolCallId);
    if (progress && progress.length > 0) {
      parent.progress = progress;
    }
  }

  // Collect `data-delegate-ledger` parts to attach server-reported
  // `durationMs` to reconstructed tool-call entries.
  // Keys are `${delegateToolCallId}-${originalToolCallId}` to match the
  // namespaced ids stored in the accumulator.
  const durationMap = new Map<string, number>();
  for (const part of msg.parts) {
    if (typeof part !== "object" || part === null || !("type" in part)) continue;
    if (part.type !== "data-delegate-ledger") continue;
    if (!("data" in part) || typeof part.data !== "object" || part.data === null) continue;
    const delegateToolCallId =
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
      if (delegateToolCallId && childId && dur !== undefined && dur > 0) {
        durationMap.set(`${delegateToolCallId}-${childId}`, dur);
      }
    }
  }

  // Walk every reconstructed tree (including nested) and stamp durationMs
  // from the ledger where available. Tree ids are already namespaced.
  function attachDurations(entries: ToolCallDisplay[]): void {
    for (const entry of entries) {
      if (!entry.durationMs && durationMap.has(entry.toolCallId)) {
        entry.durationMs = durationMap.get(entry.toolCallId);
      }
      if (entry.children && entry.children.length > 0) {
        attachDurations(entry.children);
      }
    }
  }
  attachDurations(calls);

  // Reconciliation rules. `delegate-end` is checked first; the
  // parent-state fallback only applies to delegates that did NOT receive
  // an explicit terminator (even an empty one).
  const parentDone = isMessageDone(msg);
  for (const [delegateToolCallId, parent] of byToolCallId) {
    if (parent.toolName !== "delegate") continue;
    const children = parent.children;
    if (!children) continue;
    if (delegateEndPending.has(delegateToolCallId)) {
      const pending = delegateEndPending.get(delegateToolCallId) ?? [];
      const pendingSet = new Set(pending);
      for (const child of children) {
        if (pendingSet.has(child.toolCallId)) interruptSubtree(child);
      }
      continue;
    }
    if (parentDone) {
      for (const child of children) interruptSubtree(child);
    }
  }

  return calls;
}
