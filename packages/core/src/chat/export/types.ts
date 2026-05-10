/**
 * Shared render-shape types used by the live chat UI and the chat export
 * route. Lifted from `tools/agent-playground/.../types.ts` so server-side
 * HTML generation in `apps/atlasd` can reuse the same render helpers
 * without dragging Svelte into the daemon.
 *
 * @module
 */

/**
 * Flattened tool-call shape extracted from a message's `parts` array at
 * render time. Covers both static `tool-<name>` parts and the `dynamic-tool`
 * fallback. The chat message list renders these as inline status cards so
 * the user can see tool activity live instead of staring at a long pause
 * while Friday fetches URLs or runs Python.
 *
 * See AI SDK v6's `ToolUIPart<TOOLS>` and `DynamicToolUIPart` types for the
 * canonical source — we flatten to a single string-based shape because the
 * rendering component doesn't need type-level tool discrimination.
 */
export interface ToolCallDisplay {
  toolCallId: string;
  toolName: string;
  state:
    | "input-streaming"
    | "input-available"
    | "approval-requested"
    | "approval-responded"
    | "output-available"
    | "output-error"
    | "output-denied";
  /** Tool arguments (may be partial during `input-streaming`). */
  input?: unknown;
  /** Tool result once `state === "output-available"`. */
  output?: unknown;
  /** Error message when `state === "output-error"`. */
  errorText?: string;
  /**
   * Nested tool calls reconstructed from `data-delegate-chunk` envelopes
   * forwarded by the `delegate` tool's proxy writer. Present only on
   * top-level `tool-delegate` entries; child IDs are namespaced as
   * `${delegateToolCallId}::${childToolCallId}`.
   */
  children?: ToolCallDisplay[];
  /**
   * Accumulated reasoning text from `reasoning-delta` chunks observed inside
   * `data-delegate-chunk` envelopes. Only populated for delegate/agent tool
   * entries that produced reasoning during their execution.
   */
  reasoning?: string;
  /**
   * Ephemeral progress lines from `data-tool-progress` events observed
   * inside delegate envelopes (e.g. "Analyzing query..." from the web agent).
   */
  progress?: string[];
  /**
   * Accumulated text response from `text-delta` chunks observed inside
   * `data-delegate-chunk` envelopes. This is the delegate agent's prose
   * output (e.g. a markdown summary table) rendered inline when the
   * delegate card is expanded.
   */
  delegateText?: string;
  /**
   * Server-reported duration in milliseconds for this tool call. Populated
   * from `data-delegate-ledger` entries when available. For nested agent
   * calls (e.g., fetch under agent_web), duration may be absent — the UI
   * falls back to client-side elapsed-time tracking.
   */
  durationMs?: number;
  /** Workspace/session/action context observed from surrounding nested FSM chunks. */
  workspaceId?: string;
  sessionId?: string;
  actionId?: string;
  jobName?: string;
}

export interface ImageDisplay {
  url: string;
  filename?: string;
  mediaType: string;
}

/**
 * A segment within a chat message that preserves the chronological order
 * of the assistant's stream. Consecutive text parts are coalesced into a
 * single `text` segment; consecutive tool calls (and any reasoning that
 * arrived between them) are grouped into a `tool-burst` segment.
 *
 * Replaces the old split of `content: string` + `toolCalls[]` and lets the
 * UI render prose and tool activity in the order they actually happened.
 */
export type Segment =
  | { type: "text"; content: string }
  | {
      type: "tool-burst";
      /** Deterministic id so open/closed state is stable across renders. */
      id: string;
      calls: ToolCallDisplay[];
      /** Coalesced reasoning text from `reasoning-delta` chunks observed inside this burst. */
      reasoning?: string;
    };
