/**
 * Session History v2 — Storage adapter interface.
 *
 * Defines the contract for persisting and retrieving session stream events.
 * Single production implementation today: `JetStreamSessionHistoryAdapter`.
 * Tests use a thin in-memory implementation defined inline (e.g.
 * `apps/atlasd/routes/sessions/sessions.test.ts`).
 *
 * @module
 */

import type { SessionStreamEvent, SessionSummary, SessionView } from "./session-events.ts";

/**
 * Storage adapter for session history v2. Supports incremental appends
 * during execution and full session retrieval after completion.
 */
export interface SessionHistoryAdapter {
  /**
   * Append a single event to the session's JSONL event log.
   * Called during live execution for crash recovery.
   */
  appendEvent(sessionId: string, event: SessionStreamEvent): Promise<void>;

  /**
   * Finalize a session: write all events and a pre-computed summary.
   * Called at session completion/failure.
   */
  save(sessionId: string, events: SessionStreamEvent[], summary: SessionSummary): Promise<void>;

  /**
   * Overwrite the persisted summary for an already-finalized session. Used
   * by the C2 detached `aiSummary` flow: `save()` lands a synchronous-fallback
   * summary on the critical path; once the LLM-generated summary completes
   * out-of-band, this method updates the metadata KV / metadata.json without
   * touching the events log. Last-write-wins by sessionId; safe to call
   * concurrently for the same session.
   */
  updateSummary(sessionId: string, summary: SessionSummary): Promise<void>;

  /**
   * Load a session by ID, reducing stored events into a SessionView.
   * Returns null if the session does not exist.
   */
  get(sessionId: string): Promise<SessionView | null>;

  /**
   * List session summaries, sorted by startedAt descending.
   * When workspaceId is provided, filters to that workspace only.
   */
  listByWorkspace(workspaceId?: string): Promise<SessionSummary[]>;

  /**
   * Walk sessions that have events but no finalized summary and mark them
   * "interrupted". Called on daemon startup so sessions whose process died
   * mid-flight don't appear stuck. Returns the number of sessions marked.
   */
  markInterruptedSessions(): Promise<number>;

  /**
   * List in-flight sessions (have a marker in SESSION_INFLIGHT but no
   * terminal summary). Optionally filter by workspaceId — markers carry
   * `workspaceId` and `signalId` set by the start-event writer; legacy
   * markers without those fields are returned unfiltered when no
   * workspaceId is requested.
   */
  listInflight(
    workspaceId?: string,
  ): Promise<
    Array<{ sessionId: string; startedAt: string; workspaceId?: string; signalId?: string }>
  >;
}
