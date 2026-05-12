import type { AtlasUIMessage } from "@atlas/agent-sdk";

/**
 * Part types that represent in-stream error conditions. When the workspace
 * runtime fails a session before producing any text, the agent-sdk emits
 * `data-error` (generic), `data-agent-error` (agent executor), or
 * `data-agent-timeout` (tool timeout). We surface all three as "this turn
 * errored" in the UI.
 */
const ERROR_PART_TYPES = new Set(["data-error", "data-agent-error", "data-agent-timeout"]);

/**
 * Part types that count as "user can see something for this message" — text,
 * files, reasoning, tool cards, and error bubbles. Used to filter the
 * phantom AI SDK assistant message that only has `[data-session-start]`,
 * while keeping error-only turns visible so session failures don't look
 * like silent success.
 */
export function hasRenderableContent(msg: AtlasUIMessage): boolean {
  if (!Array.isArray(msg.parts)) return false;
  return msg.parts.some((p) => {
    if (typeof p !== "object" || p === null || !("type" in p)) return false;
    const t = (p as { type: unknown }).type;
    if (typeof t !== "string") return false;
    return (
      t === "text" ||
      t === "file" ||
      t === "reasoning" ||
      t === "dynamic-tool" ||
      ERROR_PART_TYPES.has(t) ||
      t.startsWith("tool-")
    );
  });
}

/**
 * Concatenate every error string carried by this message's data-error /
 * data-agent-error / data-agent-timeout parts. Returns undefined when the
 * message has no error content — call sites render an error bubble only
 * when this returns a string.
 */
export function extractErrorText(msg: AtlasUIMessage): string | undefined {
  if (!Array.isArray(msg.parts)) return undefined;
  const errors: string[] = [];
  for (const part of msg.parts) {
    if (typeof part !== "object" || part === null || !("type" in part)) continue;
    const t = (part as { type: unknown }).type;
    if (typeof t !== "string" || !ERROR_PART_TYPES.has(t)) continue;
    const data = (part as { data?: unknown }).data;
    if (typeof data !== "object" || data === null) continue;
    const err = (data as { error?: unknown }).error;
    if (typeof err === "string" && err.length > 0) errors.push(err);
  }
  return errors.length > 0 ? errors.join("\n") : undefined;
}

/**
 * True when a message carries any error chunk. Used by the `thinking`
 * derived state to exit the "…" indicator once an error bubble has
 * rendered — otherwise the dots keep bouncing forever when the turn
 * produced no text but did produce an error.
 */
export function hasErrorPart(msg: AtlasUIMessage): boolean {
  if (!Array.isArray(msg.parts)) return false;
  return msg.parts.some((p) => {
    if (typeof p !== "object" || p === null || !("type" in p)) return false;
    const t = (p as { type: unknown }).type;
    return typeof t === "string" && ERROR_PART_TYPES.has(t);
  });
}
