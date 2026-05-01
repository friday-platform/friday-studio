/**
 * Pipeline data utilities for humanizing FSM state IDs and filtering noise nodes.
 *
 * Pure functions — no side effects, no imports beyond types.
 */

import type { Topology, TopologyNode } from "./topology.ts";

// ==============================================================================
// STEP NAME HUMANIZATION
// ==============================================================================

/** Abbreviations that should be fully uppercased in humanized labels */
const UPPERCASE_ABBREVIATIONS = new Set(["pr", "api", "url", "id", "ci", "cd", "ui"]);

/**
 * Converts an FSM state ID into a human-readable label.
 *
 * Strips the `step_` prefix if present, replaces underscores with spaces,
 * and title-cases each word. Known abbreviations (PR, API, etc.) are uppercased.
 *
 * @param stateId - FSM state identifier (e.g. "step_clone_repo")
 * @returns Human-readable label (e.g. "Clone Repo")
 */
export function humanizeStepName(stateId: string): string {
  if (stateId === "") return "";

  const stripped = stateId.startsWith("step_") ? stateId.slice(5) : stateId;
  if (stripped === "") return "";

  return stripped
    .split("_")
    .map((word) => {
      if (UPPERCASE_ABBREVIATIONS.has(word.toLowerCase())) {
        return word.toUpperCase();
      }
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join(" ");
}

// ==============================================================================
// NOISE NODE FILTERING
// ==============================================================================

/**
 * Filters out noise nodes from a topology — terminal nodes and the idle initial
 * state (a state matching an initial state ID that has no agent/llm entry actions).
 *
 * Edges referencing removed nodes are also pruned.
 *
 * @param topology - Source topology from deriveTopology
 * @param initialStateIds - FSM `initial` property values, one per job (e.g. "idle")
 * @returns Filtered topology with noise nodes and orphaned edges removed
 */
export function filterNoiseNodes(
  topology: Topology,
  initialStateIds: string | ReadonlySet<string>,
): Topology {
  const initials =
    typeof initialStateIds === "string" ? new Set([initialStateIds]) : initialStateIds;

  const removedIds = new Set<string>();

  const nodes = topology.nodes.filter((node) => {
    // Always remove terminal nodes
    if (node.type === "terminal") {
      removedIds.add(node.id);
      return false;
    }

    // Remove the initial state if it has no agent/llm metadata
    if (isIdleInitialState(node, initials)) {
      removedIds.add(node.id);
      return false;
    }

    return true;
  });

  const edges = topology.edges.filter(
    (edge) => !removedIds.has(edge.from) && !removedIds.has(edge.to),
  );

  return {
    nodes,
    edges,
    ...(topology.unsupportedJobs ? { unsupportedJobs: topology.unsupportedJobs } : {}),
  };
}

/**
 * Extracts all FSM initial state IDs from a workspace config's jobs.
 *
 * @param config - Workspace configuration with jobs
 * @returns Set of initial state IDs across all FSM jobs
 */
export function extractInitialStateIds(config: {
  jobs?: Record<string, { fsm?: { initial: string } }>;
}): Set<string> {
  const ids = new Set<string>();
  if (!config.jobs) return ids;
  for (const job of Object.values(config.jobs)) {
    if (job.fsm?.initial) ids.add(job.fsm.initial);
  }
  return ids;
}

/**
 * Checks if a node represents the FSM's idle initial state — an agent-step node
 * whose label matches an initial state ID and has no agent/llm entry actions
 * (empty metadata or no `type` field indicating agent/llm).
 */
function isIdleInitialState(node: TopologyNode, initialStateIds: ReadonlySet<string>): boolean {
  if (node.type !== "agent-step") return false;
  if (!initialStateIds.has(node.label)) return false;

  // A state with agent/llm actions will have metadata.type set to "agent" or "llm"
  return !node.metadata.type;
}
