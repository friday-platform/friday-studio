/**
 * FSM type definitions for workspace configuration mutations.
 *
 * Re-exports types and schemas from @atlas/fsm-engine for use in mutation functions.
 */

import {
  type Action as FSMAction,
  type AgentAction as FSMAgentAction,
  type FSMDefinition,
  FSMDefinitionSchema,
  type LLMAction as FSMLLMAction,
  type StateDefinition,
} from "@atlas/fsm-engine";

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

/**
 * Union of all FSM action types.
 */
/**
 * Bundled agent call in FSM state entry.
 */
/**
 * Inline LLM action in FSM state entry.
 */
export type { FSMAction, FSMAgentAction, FSMLLMAction };

/**
 * Other FSM action types (code, emit) that we don't expose via config API.
 */
export type FSMOtherAction = Exclude<FSMAction, FSMAgentAction | FSMLLMAction>;

/**
 * Parse an FSM definition and return the validated result.
 * Use when you need both validation and the parsed data.
 */
export function parseFSMDefinition(fsm: unknown) {
  return FSMDefinitionSchema.safeParse(fsm);
}
