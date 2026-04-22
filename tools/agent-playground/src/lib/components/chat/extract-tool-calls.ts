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
    applyChunk(acc, chunk);
  }

  // Attach reconstructed children to their parent delegate entries.
  for (const [delegateToolCallId, acc] of grouped) {
    const parent = byToolCallId.get(delegateToolCallId);
    if (!parent) continue;
    parent.children = [...acc.values()];
  }

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
        if (pendingSet.has(child.toolCallId)) interruptChild(child);
      }
      continue;
    }
    if (parentDone) {
      for (const child of children) interruptChild(child);
    }
  }

  return calls;
}
