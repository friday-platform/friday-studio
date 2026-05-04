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
export type {
  CredentialPathType,
  CredentialUsage,
  ParsedCredentialPath,
} from "./credentials.ts";
export {
  extractCredentials,
  parseCredentialPath,
  stripCredentialRefs,
  toIdRefs,
  toProviderRefs,
  updateCredential,
} from "./credentials.ts";
export type { FSMAgentResponse, FSMAgentUpdate } from "./fsm-agents.ts";
// FSM agent extraction and mutations
export {
  extractFSMAgents,
  FSMAgentUpdateSchema,
  updateFSMAgent,
} from "./fsm-agents.ts";
// FSM types (re-exported from @atlas/fsm-engine)
export type {
  FSMAction,
  FSMAgentAction,
  FSMDefinition,
  FSMLLMAction,
  FSMOtherAction,
  FSMStateDefinition,
} from "./fsm-types.ts";
export { parseInlineFSM } from "./fsm-types.ts";
// Integration derivation
export type {
  IntegrationCredential,
  IntegrationMCPServer,
  IntegrationsData,
} from "./integrations.ts";
export { deriveIntegrations } from "./integrations.ts";
// MCP server mutations
export type { ServerReference } from "./mcp-servers.ts";
export {
  disableMCPServer,
  enableMCPServer,
  findServerReferences,
} from "./mcp-servers.ts";
// Signal mutations
export {
  createSignal,
  deleteSignal,
  patchSignalConfig,
  updateSignal,
} from "./signals.ts";
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
  NotSupportedError,
  ValidationError,
  WriteError,
} from "./types.ts";
// Workspace-level agent extraction
export type { WorkspaceAgent } from "./workspace-agents.ts";
export { deriveWorkspaceAgents } from "./workspace-agents.ts";
