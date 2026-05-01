/**
 * Before persisting an assistant message to chat storage, sweep any
 * tool-call parts that never reached a terminal state and flip them to
 * `output-error`.
 *
 * Why: AI SDK v6 tool parts transition through
 * `input-streaming → input-available → output-available | output-error | output-denied`.
 * When a turn is cancelled mid-tool (user hit Stop, session abort, agent
 * crash), the closing chunk (`output-*`) is never emitted, so the part
 * stays in `input-streaming` or `input-available` forever. The chat page
 * then renders a "running…" spinner for a tool that will never resolve —
 * the only way out is "New Chat."
 *
 * Terminal states we leave alone:
 *   - output-available, output-error, output-denied
 *   - approval-requested / approval-responded (user-driven, not abandoned)
 *
 * Non-terminal states we close as `output-error` with a caller-provided
 * reason:
 *   - input-streaming
 *   - input-available
 *
 * This is intentionally *only* called from the persist path — it's not a
 * live-state mutation. Running turns keep their non-terminal states so
 * the UI can render in-progress spinners normally.
 *
 * @module
 */

/**
 * Plain tool-part shape we read/write. Loose typing on purpose: the real
 * `UIMessagePart<...>` from the AI SDK is a tagged union with dozens of
 * variants; Zod parsing over the whole thing isn't free and adds coupling.
 * The sweep only cares about three fields (`type`, `state`, `errorText`)
 * and touches them via in-place mutation on the part object, which the
 * message reducer tolerates.
 */
interface ToolishPart {
  type?: string;
  state?: string;
  errorText?: string;
  [k: string]: unknown;
}

/**
 * Only the `parts` field matters. Intentionally loose: callers pass us
 * `AtlasUIMessage` (from agent-sdk), `UIMessage` (from AI SDK), or a plain
 * object in tests — none share an index signature, and none want a deep
 * cast. Structural shape is all the sweep needs.
 */
interface MessageLike {
  parts?: unknown;
}

/** Tool-part types carry a `state` field; match both static `tool-*` and dynamic. */
function isToolPart(part: unknown): part is ToolishPart {
  if (typeof part !== "object" || part === null) return false;
  const t = (part as { type?: unknown }).type;
  if (typeof t !== "string") return false;
  return t.startsWith("tool-") || t === "dynamic-tool";
}

/** Non-terminal states — tool was mid-flight when the turn ended. */
const PENDING_TOOL_STATES = new Set<string>(["input-streaming", "input-available"]);

export interface ClosePendingToolPartsResult {
  /** How many parts were rewritten. 0 means the message was already clean. */
  closed: number;
}

/**
 * In-place: flip any pending tool parts on `message` to `output-error`.
 * Returns the same reference plus a count for logging.
 *
 * The default error text ("Tool call interrupted") matches the cancel-UX
 * language so a user who hit Stop sees a sensible reason in the transcript.
 * Callers with more context (timeout vs. abort vs. crash) can override it.
 */
export function closePendingToolParts(
  message: MessageLike,
  reason: string = "Tool call interrupted",
): ClosePendingToolPartsResult {
  if (!Array.isArray(message.parts)) return { closed: 0 };
  let closed = 0;
  for (const part of message.parts) {
    if (!isToolPart(part)) continue;
    const state = typeof part.state === "string" ? part.state : "";
    if (!PENDING_TOOL_STATES.has(state)) continue;
    part.state = "output-error";
    if (typeof part.errorText !== "string" || part.errorText.length === 0) {
      part.errorText = reason;
    }
    closed++;
  }
  return { closed };
}
