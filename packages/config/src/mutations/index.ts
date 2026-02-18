/**
 * Workspace configuration mutations - public exports
 *
 * Pure functions for creating, updating, and deleting workspace config entities.
 * Use with applyMutation() to handle the full load → mutate → validate → write cycle.
 */

export type { ApplyMutationOptions } from "./apply.ts";
// Orchestrator
export { applyMutation, FilesystemConfigWriter } from "./apply.ts";
// Credential extraction and mutation
export type { CredentialUsage } from "./credentials.ts";
export {
  extractCredentials,
  stripCredentialRefs,
  toIdRefs,
  toProviderRefs,
  updateCredential,
} from "./credentials.ts";
export type { FSMAgentResponse, FSMAgentUpdate } from "./fsm-agents.ts";
// FSM agent extraction and mutations
export { extractFSMAgents, FSMAgentUpdateSchema, updateFSMAgent } from "./fsm-agents.ts";
// FSM types (re-exported from @atlas/fsm-engine)
export type {
  FSMAction,
  FSMAgentAction,
  FSMDefinition,
  FSMLLMAction,
  FSMOtherAction,
  FSMStateDefinition,
} from "./fsm-types.ts";
// Signal mutations
export { createSignal, deleteSignal, updateSignal } from "./signals.ts";
// Types
export type {
  CascadeTarget,
  ConfigWriter,
  ConflictError,
  DeleteOptions,
  InvalidOperationError,
  JobCascadeTarget,
  MutationError,
  MutationFn,
  MutationResult,
  NotFoundError,
  ValidationError,
  WriteError,
} from "./types.ts";
