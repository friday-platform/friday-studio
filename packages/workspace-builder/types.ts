/**
 * Type definitions for workspace-builder package.
 *
 * Blueprint types (WorkspaceBlueprint, JobWithDAG, etc.) are defined in
 * @atlas/schemas/workspace and re-exported here for public API compatibility.
 * Builder types (Result, BuildError, StateConfig, etc.) support the FSMBuilder fluent API.
 */

import type { Action, FSMDefinition, JSONSchema, TransitionDefinition } from "../fsm-engine/mod.ts";

// ---------------------------------------------------------------------------
// Blueprint types — re-exported from @atlas/schemas/workspace
// ---------------------------------------------------------------------------

export type {
  Agent,
  ClassifiedDAGStep,
  Conditional,
  CredentialBinding,
  DAGStep,
  DocumentContract,
  JobWithDAG,
  PrepareMapping,
  Signal,
  SignalConfig,
  WorkspaceBlueprint,
} from "@atlas/schemas/workspace";
export {
  ClassifiedDAGStepSchema,
  CredentialBindingSchema,
  PrepareMappingSchema,
  WorkspaceBlueprintSchema,
} from "@atlas/schemas/workspace";

/** Sentinel documentId for prepare mappings sourced from the trigger signal payload. */
export const SIGNAL_DOCUMENT_ID = "__trigger_signal__";
export type { ClassifiedJobWithDAG } from "./planner/stamp-execution-types.ts";

// ---------------------------------------------------------------------------
// FSM Builder types
// ---------------------------------------------------------------------------

export type Result<T, E> = { success: true; value: T } | { success: false; error: E };

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

export interface BuildError {
  type: BuildErrorType;
  message: string;
  context?: Record<string, unknown>;
}

export interface StateConfig {
  name: string;
  entry: Action[];
  on: Record<string, TransitionConfig | TransitionConfig[]>;
  final?: boolean;
}

export interface TransitionConfig {
  target: string;
  guards: string[];
  actions: Action[];
}

export interface FunctionConfig {
  type: "action" | "guard";
  code: string;
}

export type { Action, FSMDefinition, JSONSchema, TransitionDefinition };

// ---------------------------------------------------------------------------
// Workspace-builder extended FSM types
//
// The compiler (build-fsm.ts) generates guard functions as compiled JavaScript
// stored in the `functions` map. Guards are not currently executed by the FSM
// engine but document the intended transition logic.
// ---------------------------------------------------------------------------

export interface CompiledTransitionDefinition {
  target: string;
  guards?: string[];
  actions?: Action[];
}

export interface CompiledStateDefinition {
  documents?: unknown[];
  entry?: Action[];
  on?: Record<string, CompiledTransitionDefinition | CompiledTransitionDefinition[]>;
  type?: "final";
}

/** Extended FSM definition produced by the workspace-builder compiler. */
export interface CompiledFSMDefinition {
  id: string;
  initial: string;
  states: Record<string, CompiledStateDefinition>;
  documentTypes?: Record<string, JSONSchema>;
  functions?: Record<string, { type: "action" | "guard"; code: string }>;
}
