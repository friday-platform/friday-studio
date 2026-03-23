/**
 * Maps session execution data onto topology node IDs to produce per-node
 * execution status. Used by the Living Blueprint and Filmstrip features
 * to render step-level status in the pipeline diagram.
 *
 * Pure function — no side effects.
 *
 * @module
 */

import type { SessionSummary, SessionView } from "@atlas/core/session/session-events";
import type { Topology } from "./topology.ts";

// ==============================================================================
// TYPES
// ==============================================================================

export type StepStatus = "pending" | "active" | "completed" | "failed";

// ==============================================================================
// IMPLEMENTATION
// ==============================================================================

/**
 * Maps session execution state onto topology node IDs.
 *
 * Joins `AgentBlock.stateId` from the session to topology node IDs
 * (format `{jobId}:{stateId}`) to produce a status map the pipeline
 * diagram can consume for border colors and icons.
 *
 * @param session - Session summary or full session view. Only `SessionView`
 *   contains `agentBlocks`; `SessionSummary` produces an empty map.
 * @param topology - Workspace topology with node IDs in `{jobId}:{stateId}` format
 * @returns Map from topology node ID to execution status
 */
export function mapSessionToStepStatus(
  session: SessionSummary | SessionView,
  topology: Topology,
): Map<string, StepStatus> {
  const result = new Map<string, StepStatus>();

  // SessionSummary lacks agentBlocks — can't map without block data
  if (!("agentBlocks" in session) || session.agentBlocks.length === 0) {
    return result;
  }

  // Build a set of valid topology node IDs for fast lookup
  const topologyNodeIds = new Set(topology.nodes.map((n) => n.id));

  // Build node ID from jobName + stateId
  const { jobName } = session;

  for (const block of session.agentBlocks) {
    if (!block.stateId) continue;

    const nodeId = `${jobName}:${block.stateId}`;
    if (!topologyNodeIds.has(nodeId)) continue;

    // Map AgentBlock status to StepStatus
    switch (block.status) {
      case "completed":
      case "skipped":
        result.set(nodeId, "completed");
        break;
      case "running":
        result.set(nodeId, "active");
        break;
      case "failed":
        result.set(nodeId, "failed");
        break;
      case "pending":
        result.set(nodeId, "pending");
        break;
    }
  }

  return result;
}
