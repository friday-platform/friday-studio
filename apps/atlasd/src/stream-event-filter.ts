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

const INTERNAL_EVENT_PREFIXES = ["data-fsm-", "data-session-"];

/**
 * Returns true if the event should be forwarded to the client's SSE stream.
 * Internal pipeline events (FSM lifecycle, session management) are filtered out.
 */
export function isClientSafeEvent(chunk: { type: string }): boolean {
  for (const prefix of INTERNAL_EVENT_PREFIXES) {
    if (chunk.type.startsWith(prefix) && chunk.type !== "data-session-start") return false;
  }
  return true;
}
