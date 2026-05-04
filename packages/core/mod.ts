/**
 * @atlas/core - Core Atlas functionality
 *
 * This package provides the core workspace management functionality for Atlas.
 */

// Workspace functionality moved to @atlas/workspace package

export { findServerReferences } from "@atlas/config/mutations";
export type { ToolScope } from "./src/agent-conversion/agent-tool-filters.ts";
export {
  LLM_AGENT_ALLOWED_PLATFORM_TOOLS,
  SCOPE_INJECTED_PLATFORM_TOOLS,
  wrapPlatformToolsWithScope,
} from "./src/agent-conversion/agent-tool-filters.ts";
// Export LLM agent conversion types and functions
export type { LLMOutput } from "./src/agent-conversion/from-llm.ts";
export {
  convertLLMToAgent,
  LLMOutputSchema,
  wrapAtlasAgent,
} from "./src/agent-conversion/from-llm.ts";
export type { LLMAgentConfig } from "./src/agent-conversion/index.ts";
// Agent Conversion Layer
export { convertLLMAgentToSDK } from "./src/agent-conversion/index.ts";
// Agent Loader and Registry
export { AgentLoader, AgentRegistry } from "./src/agent-loader/index.ts";
export * from "./src/agent-server/mod.ts";
// Atlas Configuration
export { getAtlasBaseUrl, getCredentialsApiUrl } from "./src/atlas-config.ts";
// Conversation Storage
export { conversationStorage } from "./src/chat-storage.ts";
export * from "./src/constants/supervisor-status.ts";
// Credential Fetcher
export * from "./src/credential-fetcher.ts";
// Error types
export { MissingEnvironmentError } from "./src/errors/missing-environment-error.ts";
export { SessionFailedError } from "./src/errors/session-failed-error.ts";
export { UserConfigurationError } from "./src/errors/user-configuration-error.ts";
export { WorkspaceNotFoundError } from "./src/errors/workspace-not-found-error.ts";
export {
  CredentialNotFoundError,
  hasUnusableCredentialCause,
  LinkCredentialExpiredError,
  LinkCredentialNotFoundError,
  NoDefaultCredentialError,
  resolveCredentialsByProvider,
} from "./src/mcp-registry/credential-resolver.ts";
// MCP Registry - use @atlas/core/mcp-registry/registry-consolidated subpath to avoid pulling in agent-loader
export { validateRequiredFields } from "./src/mcp-registry/requirement-validator.ts";
export type {
  MCPServerMetadata,
  MCPServersRegistry,
  RequiredConfigField,
} from "./src/mcp-registry/schemas.ts";
export type {
  EnrichedMCPServer,
  ServerReference,
  WorkspaceMCPStatus,
} from "./src/mcp-registry/workspace-mcp.ts";
export { getWorkspaceMCPStatus } from "./src/mcp-registry/workspace-mcp.ts";
export type {
  AgentExecutionContext,
  AgentOrchestratorConfig,
  IAgentOrchestrator,
} from "./src/orchestrator/agent-orchestrator.ts";
// Agent Orchestrator
export { AgentOrchestrator } from "./src/orchestrator/agent-orchestrator.ts";
// Event Emission Mapper (FSM events → session stream events)
export {
  type AgentResultData,
  isAgentAction,
  mapActionToStepComplete,
  mapActionToStepStart,
  mapStateSkippedToStepSkipped,
  mapValidationAttemptToStepValidation,
} from "./src/session/event-emission-mapper.ts";
// Session History
export { mapFsmEventToSessionEvent } from "./src/session/fsm-event-mapper.ts";
export * from "./src/session/history-storage.ts";
export { JetStreamSessionHistoryAdapter } from "./src/session/jetstream-session-history-adapter.ts";
export { LocalSessionHistoryAdapter } from "./src/session/local-session-history-adapter.ts";
// Planned Steps (FSM graph traversal)
export {
  extractPlannedSteps,
  type PlannedStep,
} from "./src/session/planned-steps.ts";
// Session Events v2
export {
  type AgentBlock,
  AgentBlockSchema,
  type EphemeralChunk,
  EphemeralChunkSchema,
  type SessionActionType,
  SessionActionTypeSchema,
  type SessionAISummary,
  SessionAISummarySchema,
  type SessionCompleteEvent,
  SessionCompleteEventSchema,
  type SessionStartEvent,
  SessionStartEventSchema,
  type SessionStatus,
  SessionStatusSchema,
  type SessionStreamEvent,
  SessionStreamEventSchema,
  type SessionSummary,
  type SessionSummaryEvent,
  SessionSummaryEventSchema,
  SessionSummarySchema,
  type SessionView,
  SessionViewSchema,
  type StepCompleteEvent,
  StepCompleteEventSchema,
  type StepStartEvent,
  StepStartEventSchema,
  type StepValidationEvent,
  StepValidationEventSchema,
  type ToolCallSummary,
  ToolCallSummarySchema,
} from "./src/session/session-events.ts";
export type { SessionHistoryAdapter } from "./src/session/session-history-adapter.ts";
// Session Reducer
export {
  buildSessionView,
  initialSessionView,
  reduceSessionEvent,
} from "./src/session/session-reducer.ts";
// Stream Emitters
export {
  CallbackStreamEmitter,
  CancellationNotificationSchema,
  MCPStreamEmitter,
} from "./src/streaming/stream-emitters.ts";
// Export error types explicitly
export type {
  APIErrorCause,
  ErrorCause,
  NetworkErrorCause,
  UnknownErrorCause,
} from "./src/types/error-causes.ts";
// Core types
export type {
  IWorkspaceSession,
  IWorkspaceSignal,
} from "./src/types/legacy.ts";
// Outline Reference schemas for standardized agent outline updates
export {
  type OutlineRef,
  OutlineRefSchema,
  type OutlineRefsResult,
  OutlineRefsResultSchema,
} from "./src/types/outline-ref.ts";
export {
  createErrorCause,
  getErrorDisplayMessage,
  isAPIErrorCause,
  parseAPICallError,
  throwWithCause,
} from "./src/utils/error-helpers.ts";
