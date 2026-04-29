/**
 * Derives agent-to-step cross-reference map from workspace configuration.
 *
 * For each workspace agent, scans all FSM states' entry actions to find
 * which steps reference that agent. Used by the agent sidebar "Used In"
 * section to show where an agent appears in the pipeline.
 *
 * Pure function — no side effects, no daemon API calls.
 *
 * @module
 */

import { JobSpecificationSchema } from "./jobs.ts";
import { parseInlineFSM } from "./mutations/fsm-types.ts";
import { humanizeStepName } from "./pipeline-utils.ts";
import type { WorkspaceConfig } from "./workspace.ts";

// ==============================================================================
// TYPES
// ==============================================================================

export interface AgentStepRef {
  /** Job this step belongs to */
  jobId: string;
  /** FSM state ID */
  stepId: string;
  /** Humanized step name */
  stepName: string;
}

// ==============================================================================
// IMPLEMENTATION
// ==============================================================================

/**
 * Maps each workspace agent to all FSM steps that reference it.
 *
 * Agents not referenced by any step are included with empty arrays
 * (not omitted) so the caller can distinguish "unused" from "not defined".
 *
 * @param config - Workspace configuration
 * @returns Map from agent ID to array of step references
 */
export function deriveAgentJobUsage(config: WorkspaceConfig): Map<string, AgentStepRef[]> {
  const result = new Map<string, AgentStepRef[]>();

  // Initialize all workspace agents with empty arrays
  if (config.agents) {
    for (const agentId of Object.keys(config.agents)) {
      result.set(agentId, []);
    }
  }

  if (!config.jobs) return result;

  for (const [jobId, rawJob] of Object.entries(config.jobs)) {
    const job = JobSpecificationSchema.safeParse(rawJob);
    if (!job.success || !job.data.fsm) continue;

    const parsed = parseInlineFSM(job.data.fsm, jobId);
    if (!parsed.success) continue;

    for (const [stateId, state] of Object.entries(parsed.data.states)) {
      if (!state.entry) continue;

      for (const action of state.entry) {
        if (action.type !== "agent") continue;

        const refs = result.get(action.agentId);
        const ref: AgentStepRef = { jobId, stepId: stateId, stepName: humanizeStepName(stateId) };

        if (refs) {
          refs.push(ref);
        } else {
          result.set(action.agentId, [ref]);
        }
      }
    }
  }

  return result;
}
