/**
 * Session History v2 — Storage adapter interface.
 *
 * Defines the contract for persisting and retrieving session stream events.
 * Single implementation today (LocalSessionHistoryAdapter, JSONL files).
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
}
