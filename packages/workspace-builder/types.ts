/**
 * Type definitions for FSM Builder API
 */

import type { Action, FSMDefinition, JSONSchema, TransitionDefinition } from "../fsm-engine/mod.ts";

/**
 * Result type for builder operations
 * Follows the same pattern as @atlas/utils but specialized for builder
 */
export type Result<T, E> = { success: true; value: T } | { success: false; error: E };

/**
 * Build error types
 */
export type BuildErrorType =
  | "duplicate_state"
  | "duplicate_function"
  | "duplicate_document_type"
  | "no_state_context"
  | "no_transition_context"
  | "missing_initial"
  | "invalid_initial"
  | "invalid_state_reference"
  | "invalid_function_reference"
  | "invalid_guard_reference";

/**
 * Build error with context
 */
export interface BuildError {
  type: BuildErrorType;
  message: string;
  context?: Record<string, unknown>;
}

/**
 * Internal state configuration during building
 */
export interface StateConfig {
  name: string;
  entry: Action[];
  on: Record<string, TransitionConfig>;
  final?: boolean;
}

/**
 * Internal transition configuration during building
 */
export interface TransitionConfig {
  target: string;
  guards: string[];
  actions: Action[];
}

/**
 * Internal function configuration during building
 */
export interface FunctionConfig {
  type: "action" | "guard";
  code: string;
}

/**
 * Re-export types from fsm-engine for convenience
 */
export type { Action, FSMDefinition, JSONSchema, TransitionDefinition };
