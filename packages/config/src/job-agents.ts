/**
 * Derives the list of agent IDs used by a single job.
 *
 * Handles both execution-based jobs (agent pipeline) and FSM-based jobs
 * (agent actions in state entries). Returns deduplicated agent IDs in
 * encounter order.
 *
 * @module
 */

import { parseInlineFSM } from "./mutations/fsm-types.ts";

// ==============================================================================
// TYPES
// ==============================================================================

/** Minimal job shape — accepts raw config objects without requiring full Zod parse. */
interface JobLike {
  execution?: {
    agents: (string | { id: string; [key: string]: unknown })[];
    [key: string]: unknown;
  };
  fsm?: unknown;
  /** Job name — required for parsing inline FSMs which don't carry their own `id` */
  name?: string;
  [key: string]: unknown;
}

// ==============================================================================
// IMPLEMENTATION
// ==============================================================================

/**
 * Extracts deduplicated agent IDs from a job specification.
 *
 * For execution-based jobs: reads `execution.agents` (string or `{ id }` entries).
 * For FSM-based jobs: scans state entries for `type: "agent"` actions.
 *
 * @param job - Job specification (raw or parsed)
 * @returns Ordered, deduplicated array of agent IDs
 */
export function deriveJobAgents(job: JobLike): string[] {
  if (job.execution) {
    return job.execution.agents.map((a) => (typeof a === "string" ? a : a.id));
  }

  if (job.fsm) {
    const parsed = parseInlineFSM(job.fsm, job.name ?? "unknown-job");
    if (!parsed.success) return [];

    const seen = new Set<string>();
    const result: string[] = [];

    for (const state of Object.values(parsed.data.states)) {
      if (!state.entry) continue;
      for (const action of state.entry) {
        if (action.type === "agent" && !seen.has(action.agentId)) {
          seen.add(action.agentId);
          result.push(action.agentId);
        }
      }
    }

    return result;
  }

  return [];
}
