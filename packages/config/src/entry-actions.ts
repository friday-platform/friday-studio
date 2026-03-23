/**
 * Extracts typed action descriptors from an FSM state's entry array.
 *
 * Used by the Filmstrip UI to render a compact list of actions inside
 * expanded pipeline step nodes.
 *
 * Pure function — no side effects.
 *
 * @module
 */

import { JobSpecificationSchema } from "./jobs.ts";
import type { FSMAction, FSMStateDefinition } from "./mutations/fsm-types.ts";
import { parseFSMDefinition } from "./mutations/fsm-types.ts";
import type { WorkspaceConfig } from "./workspace.ts";

// ==============================================================================
// TYPES
// ==============================================================================

export interface EntryAction {
  type: "code" | "agent" | "llm" | "emit";
  name: string;
  agentId?: string;
  outputTo?: string;
  outputType?: string;
  event?: string;
}

// ==============================================================================
// IMPLEMENTATION
// ==============================================================================

/**
 * Extracts typed action descriptors from an FSM state's entry array.
 *
 * Maps each FSM action to a compact descriptor suitable for filmstrip rendering:
 * - `code` actions: name is the `function` field
 * - `agent` actions: name is the `agentId`, includes `outputTo`
 * - `llm` actions: name is `{provider}/{model}`, includes `outputTo` and `outputType`
 * - `emit` actions: name is the `event` field
 *
 * @param stateDefinition - FSM state definition with optional entry array
 * @returns Array of entry action descriptors in declaration order
 */
export function deriveEntryActions(stateDefinition: FSMStateDefinition): EntryAction[] {
  if (!stateDefinition.entry) return [];

  return stateDefinition.entry.map(mapAction);
}

/**
 * Extracts entry actions for all FSM states in a workspace config.
 *
 * Returns a map keyed by topology node ID (`{jobId}:{stateId}`) so the
 * pipeline diagram can look up entry actions per node without needing
 * access to the raw FSM definitions.
 *
 * @param config - Workspace configuration
 * @returns Map from topology node ID to entry action array
 */
export function deriveAllEntryActions(config: WorkspaceConfig): Map<string, EntryAction[]> {
  const result = new Map<string, EntryAction[]>();

  if (!config.jobs) return result;

  for (const [jobId, rawJob] of Object.entries(config.jobs)) {
    const job = JobSpecificationSchema.safeParse(rawJob);
    if (!job.success || !job.data.fsm) continue;

    const parsed = parseFSMDefinition(job.data.fsm);
    if (!parsed.success) continue;

    for (const [stateId, state] of Object.entries(parsed.data.states)) {
      const actions = deriveEntryActions(state);
      if (actions.length > 0) {
        result.set(`${jobId}:${stateId}`, actions);
      }
    }
  }

  return result;
}

/**
 * Maps a single FSM action to an EntryAction descriptor.
 */
function mapAction(action: FSMAction): EntryAction {
  switch (action.type) {
    case "code":
      return { type: "code", name: action.function };

    case "agent":
      return {
        type: "agent",
        name: action.agentId,
        agentId: action.agentId,
        ...(action.outputTo ? { outputTo: action.outputTo } : {}),
        ...(action.outputType ? { outputType: action.outputType } : {}),
      };

    case "llm":
      return {
        type: "llm",
        name: `${action.provider}/${action.model}`,
        ...(action.outputTo ? { outputTo: action.outputTo } : {}),
        ...(action.outputType ? { outputType: action.outputType } : {}),
      };

    case "emit":
      return { type: "emit", name: action.event, event: action.event };
  }
}
