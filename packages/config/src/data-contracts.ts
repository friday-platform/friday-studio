/**
 * Derives data contracts (document type flows) from workspace FSM definitions.
 *
 * A data contract represents a typed data flow between two pipeline steps:
 * the producing step's entry action declares an `outputType`, and the consuming
 * step is the transition target from the producing state.
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

export interface DataContract {
  /** Producing FSM state ID */
  fromStepId: string;
  /** Humanized producer name */
  fromStepName: string;
  /** Consuming FSM state ID (null when producer transitions to a terminal state) */
  toStepId: string | null;
  /** Humanized consumer name, or "(end)" for terminal */
  toStepName: string;
  /** The outputType value from the producer's entry action */
  documentType: string;
  /** JSON Schema from fsm.documentTypes, null if not defined */
  schema: object | null;
  /** Job this contract belongs to */
  jobId: string;
}

// ==============================================================================
// IMPLEMENTATION
// ==============================================================================

/**
 * Extracts data contracts from all FSM jobs in a workspace config.
 *
 * Walks each job's FSM states looking for entry actions with `outputType`.
 * For each match, follows the state's transitions to identify the consumer
 * step and pairs with `documentTypes` for the schema definition.
 *
 * @param config - Workspace configuration
 * @returns Array of data contracts in job/state declaration order
 */
export function deriveDataContracts(config: WorkspaceConfig): DataContract[] {
  const contracts: DataContract[] = [];

  if (!config.jobs) return contracts;

  for (const [jobId, rawJob] of Object.entries(config.jobs)) {
    const job = JobSpecificationSchema.safeParse(rawJob);
    if (!job.success || !job.data.fsm) continue;

    const parsed = parseInlineFSM(job.data.fsm, jobId);
    if (!parsed.success) continue;

    const fsm = parsed.data;
    const documentTypes = fsm.documentTypes ?? {};

    for (const [stateId, state] of Object.entries(fsm.states)) {
      if (!state.entry) continue;

      // Find the first entry action with an outputType. Only agent/llm carry
      // `outputType`; the value-level guard below re-narrows because `Array.find`
      // returns `Action | undefined`, not the predicate-narrowed shape.
      const producerAction = state.entry.find(
        (a) => (a.type === "agent" || a.type === "llm") && a.outputType,
      );
      if (!producerAction) continue;
      if (producerAction.type !== "agent" && producerAction.type !== "llm") continue;

      const outputType = producerAction.outputType;
      if (!outputType) continue;

      // Find the consumer: follow the first transition target from this state
      const consumer = findConsumer(state.on, fsm.states);

      const schema = documentTypes[outputType] ?? null;

      contracts.push({
        fromStepId: stateId,
        fromStepName: humanizeStepName(stateId),
        toStepId: consumer.stateId,
        toStepName: consumer.name,
        documentType: outputType,
        schema: schema as object | null,
        jobId,
      });
    }
  }

  return contracts;
}

/**
 * Finds the consumer step by following the first transition from a state.
 * If the target is a final state, returns null/end.
 */
function findConsumer(
  transitions: Record<string, { target: string } | { target: string }[]> | undefined,
  states: Record<string, { type?: "final" }>,
): { stateId: string | null; name: string } {
  if (!transitions) return { stateId: null, name: "(end)" };

  // Take the first transition's target
  for (const transition of Object.values(transitions)) {
    const first = Array.isArray(transition) ? transition[0] : transition;
    if (!first) continue;

    const targetId = first.target;
    const targetState = states[targetId];

    if (targetState?.type === "final") {
      return { stateId: null, name: "(end)" };
    }

    return { stateId: targetId, name: humanizeStepName(targetId) };
  }

  return { stateId: null, name: "(end)" };
}
