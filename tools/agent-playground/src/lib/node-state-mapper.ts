/**
 * Pure function that maps execution state and timeline position to per-node
 * visual states for the pipeline canvas.
 *
 * Consumed by the canvas execution overlay and timeline scrubber.
 *
 * @module
 */

import type { Topology } from "@atlas/config";
import type { ActionEntry, StateTransition } from "./execution-context.svelte.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type NodeVisualState = "idle" | "running" | "succeeded" | "failed" | "mocked" | "selected";

export interface NodeStateEntry {
  state: NodeVisualState;
  /** Duration in ms. Present for running, succeeded, and failed states. */
  elapsed?: number;
  /** Error message. Present only for failed state. */
  error?: string;
}

// ---------------------------------------------------------------------------
// Core function
// ---------------------------------------------------------------------------

/**
 * Derives per-node visual states from topology, transitions, and timeline position.
 *
 * Works with both live streaming transitions (during execution) and
 * post-execution report transitions — callers pass whichever is available.
 *
 * @param topology - The pipeline topology (nodes and edges)
 * @param transitions - State transitions (live or from report)
 * @param actionTrace - Action trace entries (live or from report)
 * @param timelineIndex - Position in stateTransitions: -1 = pre-run, N = index into transitions
 * @param mockedStates - Optional set of FSM state IDs that were mock-executed
 * @returns Map from topology node ID to visual state entry
 */
export function deriveNodeStates(
  topology: Topology,
  transitions: StateTransition[],
  actionTrace: ActionEntry[],
  timelineIndex: number,
  mockedStates?: Set<string>,
): Map<string, NodeStateEntry> {
  const result = new Map<string, NodeStateEntry>();

  // Pre-run or no transitions: everything idle
  if (transitions.length === 0 || timelineIndex < 0) {
    for (const node of topology.nodes) {
      result.set(node.id, { state: "idle" });
    }
    return result;
  }

  const clampedIndex = Math.min(timelineIndex, transitions.length - 1);

  // Build sets of visited and departed states within the visible window
  const visitedStates = new Set<string>();
  const departedStates = new Set<string>();
  for (let i = 0; i <= clampedIndex; i++) {
    const t = transitions[i];
    if (t) {
      visitedStates.add(t.from);
      visitedStates.add(t.to);
      departedStates.add(t.from);
    }
  }

  // The current state is the target of the playhead transition
  const currentTransition = transitions[clampedIndex];
  const currentState = currentTransition?.to ?? null;

  // Build action outcome map from the full trace
  const actionOutcome = buildActionOutcomeMap(actionTrace);

  // Map each topology node
  for (const node of topology.nodes) {
    const fsmState = extractFSMState(node.id);

    // Node doesn't map to an FSM state, or isn't visited yet
    if (!fsmState || !visitedStates.has(fsmState)) {
      result.set(node.id, { state: "idle" });
      continue;
    }

    const isMocked = mockedStates?.has(fsmState) ?? false;
    const departed = departedStates.has(fsmState);
    const isCurrent = fsmState === currentState;

    // Determine base state
    let state: NodeVisualState;
    let elapsed: number | undefined;
    let error: string | undefined;

    if (isCurrent && !departed) {
      // Current state at playhead, not yet departed within visible window.
      // Use action trace to determine whether action completed or is still running.
      const outcome = actionOutcome.get(fsmState);
      if (outcome?.status === "failed") {
        state = "failed";
        error = outcome.error;
        elapsed = computeRunningElapsed(fsmState, transitions, clampedIndex);
      } else if (outcome?.status === "completed") {
        state = "succeeded";
        elapsed = computeRunningElapsed(fsmState, transitions, clampedIndex);
      } else if (node.type === "terminal") {
        state = "succeeded";
      } else {
        state = "running";
        elapsed = computeRunningElapsed(fsmState, transitions, clampedIndex);
      }
    } else {
      // State was departed within the visible window -> completed
      const outcome = actionOutcome.get(fsmState);
      if (outcome?.status === "failed") {
        state = "failed";
        error = outcome.error;
        elapsed = computeElapsed(fsmState, transitions, clampedIndex);
      } else {
        state = "succeeded";
        elapsed = computeElapsed(fsmState, transitions, clampedIndex);
      }
    }

    // Override with mocked if applicable (mocked overrides succeeded/failed)
    if (isMocked && state !== "running") {
      state = "mocked";
    }

    const entry: NodeStateEntry = { state };
    if (elapsed !== undefined) entry.elapsed = elapsed;
    if (error !== undefined) entry.error = error;

    result.set(node.id, entry);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extracts the FSM state name from a topology node ID.
 *
 * Topology node IDs follow patterns:
 * - "jobId:stateId" for FSM states
 * - "signal:signalId" for signals
 *
 * For signal nodes, the "state" is the signal ID (won't match FSM transitions).
 * For FSM nodes, returns the stateId portion.
 */
function extractFSMState(nodeId: string): string | null {
  const colonIdx = nodeId.indexOf(":");
  if (colonIdx === -1) return null;
  return nodeId.slice(colonIdx + 1);
}

/** Maps FSM state names to their final action outcome. */
function buildActionOutcomeMap(
  actionTrace: ActionEntry[],
): Map<string, { status: "completed" | "failed"; error?: string }> {
  const outcomes = new Map<string, { status: "completed" | "failed"; error?: string }>();

  for (const action of actionTrace) {
    if (action.status === "completed" || action.status === "failed") {
      outcomes.set(action.state, {
        status: action.status,
        error: action.error,
      });
    }
  }

  return outcomes;
}

/**
 * Computes elapsed time for a state that has been transitioned away from.
 * Finds entry and exit timestamps from the transitions array.
 */
function computeElapsed(
  fsmState: string,
  transitions: StateTransition[],
  maxIndex: number,
): number | undefined {
  let entryTime: number | undefined;
  let exitTime: number | undefined;

  for (let i = 0; i <= maxIndex; i++) {
    const t = transitions[i];
    if (!t) continue;
    if (t.to === fsmState && entryTime === undefined) {
      entryTime = t.timestamp;
    }
    if (t.from === fsmState) {
      exitTime = t.timestamp;
    }
  }

  if (entryTime !== undefined && exitTime !== undefined) {
    return exitTime - entryTime;
  }

  return undefined;
}

/**
 * Computes elapsed time for a currently running state.
 * Uses entry timestamp and the last known transition timestamp.
 */
function computeRunningElapsed(
  fsmState: string,
  transitions: StateTransition[],
  maxIndex: number,
): number {
  let entryTime: number | undefined;

  for (let i = 0; i <= maxIndex; i++) {
    const t = transitions[i];
    if (t?.to === fsmState) {
      entryTime = t.timestamp;
      break;
    }
  }

  const lastTimestamp = transitions[maxIndex]?.timestamp;

  if (entryTime !== undefined && lastTimestamp !== undefined) {
    return lastTimestamp - entryTime;
  }

  return 0;
}
