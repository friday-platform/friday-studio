/**
 * Filter for SSE events sent to the client.
 *
 * The signal pipeline emits both AI SDK UI message stream events (start,
 * text-delta, finish, etc.) and internal FSM lifecycle events
 * (data-fsm-action-execution, data-session-start, data-session-finish).
 *
 * The AI SDK's DefaultChatTransport.processResponseStream() validates each
 * SSE event against uiMessageChunkSchema — unknown types throw and kill the
 * entire stream. We filter out internal events before they reach the client.
 */

import type { AtlasUIMessageChunk } from "@atlas/agent-sdk";

const INTERNAL_EVENT_PREFIXES = ["data-fsm-", "data-session-"];

/**
 * Returns true if the event should be forwarded to the client's SSE stream.
 * Internal pipeline events (FSM lifecycle, session management) are filtered out.
 * Narrows `unknown` to `AtlasUIMessageChunk` — client-safe events are valid
 * UI message stream chunks by definition.
 */
export function isClientSafeEvent(chunk: unknown): chunk is AtlasUIMessageChunk {
  if (typeof chunk !== "object" || chunk === null || !("type" in chunk)) return false;
  const { type } = chunk;
  if (typeof type !== "string") return false;
  for (const prefix of INTERNAL_EVENT_PREFIXES) {
    if (type.startsWith(prefix) && type !== "data-session-start") return false;
  }
  return true;
}
