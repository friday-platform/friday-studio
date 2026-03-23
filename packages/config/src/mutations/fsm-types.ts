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
 * Parse an FSM definition and return the validated result.
 * Use when you need both validation and the parsed data.
 */
export function parseFSMDefinition(fsm: unknown) {
  return FSMDefinitionSchema.safeParse(fsm);
}
