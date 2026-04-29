/**
 * FSM type definitions for workspace configuration mutations.
 *
 * Re-exports types and schemas from @atlas/fsm-engine for use in mutation functions.
 */

import { FSMDefinitionSchema } from "@atlas/fsm-engine/schema";
import type {
  Action as FSMAction,
  AgentAction as FSMAgentAction,
  FSMDefinition,
  LLMAction as FSMLLMAction,
  StateDefinition,
} from "@atlas/fsm-engine/types";

// ==============================================================================
// RE-EXPORTED TYPES FROM FSM-ENGINE
// ==============================================================================

/**
 * FSM definition embedded in a job specification.
 */
export type { FSMDefinition };

/**
 * FSM state with optional entry actions array.
 */
export type FSMStateDefinition = StateDefinition;

export type { FSMAction, FSMAgentAction, FSMLLMAction };

/**
 * Other FSM action types (code, emit) that we don't expose via config API.
 */
export type FSMOtherAction = Exclude<FSMAction, FSMAgentAction | FSMLLMAction>;

/**
 * Parse an inline FSM embedded in a workspace job config.
 *
 * Inline FSMs in workspace.yml don't include `id` — the job name is the identity.
 * The runtime injects `id` before instantiating the engine; this helper does the
 * same for config-layer code that reads FSMs (validation, extraction, topology,
 * data-contracts, etc.).
 *
 * @param fsm - Raw FSM object from workspace config
 * @param jobId - Job identifier to use as the FSM id when missing
 * @returns Safe parse result with injected id if needed
 */
export function parseInlineFSM(fsm: unknown, jobId: string) {
  const fsmWithId = typeof fsm === "object" && fsm !== null ? { id: jobId, ...fsm } : fsm;
  return FSMDefinitionSchema.safeParse(fsmWithId);
}
