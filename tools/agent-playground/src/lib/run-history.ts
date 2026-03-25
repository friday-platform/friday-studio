/**
 * LocalStorage-backed run history for the agent workbench.
 *
 * Stores up to {@link MAX_RUNS} RunRecords per agent, keyed by agent ID.
 * Persists across browser tabs and sessions.
 *
 * @module
 */

import type { DoneStats, TraceEntry } from "./server/lib/sse.ts";
import type { SSEEvent } from "./sse-types.ts";

/** A single execution run in the workbench history stack. */
export type RunRecord = {
  id: number;
  prompt: string;
  agentId: string;
  events: SSEEvent[];
  result: unknown | null;
  traces: TraceEntry[];
  stats: DoneStats | null;
  status: "running" | "success" | "error" | "cancelled";
  startedAt: number;
};

const MAX_RUNS = 50;

/** LocalStorage key for a given agent's run history. */
function storageKey(agentId: string): string {
  return `run-history-${agentId}`;
}

/**
 * Load persisted run records for an agent.
 * Returns an empty array if nothing is stored or parsing fails.
 */
export function loadRuns(agentId: string): RunRecord[] {
  try {
    const raw = localStorage.getItem(storageKey(agentId));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as RunRecord[];
  } catch {
    return [];
  }
}

/**
 * Persist run records for an agent, capped at {@link MAX_RUNS}.
 * Oldest runs (end of array) are dropped when over the cap.
 */
export function saveRuns(agentId: string, runs: RunRecord[]): void {
  try {
    const capped = runs.slice(0, MAX_RUNS);
    localStorage.setItem(storageKey(agentId), JSON.stringify(capped));
  } catch {
    // localStorage full or unavailable — silently degrade
  }
}