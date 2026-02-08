/**
 * @atlas/core - Core Atlas functionality
 *
 * This package provides the core workspace management functionality for Atlas.
 */

// Workspace functionality moved to @atlas/workspace package

// Core types
export type { IWorkspaceSession } from "../../src/types/core.ts";
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
export {
  getAtlasBaseUrl,
  getCredentialsApiUrl,
} from "./src/atlas-config.ts";
// Conversation Storage
export { conversationStorage } from "./src/chat-storage.ts";
export * from "./src/constants/supervisor-status.ts";
// Credential Fetcher
export * from "./src/credential-fetcher.ts";
// User Configuration Errors (don't count as platform failures)
export { UserConfigurationError } from "./src/errors/user-configuration-error.ts";
export {
  CredentialNotFoundError,
  LinkCredentialNotFoundError,
  resolveCredentialsByProvider,
} from "./src/mcp-registry/credential-resolver.ts";
// MCP Registry - use @atlas/core/mcp-registry/registry-consolidated subpath to avoid pulling in agent-loader
export { validateRequiredFields } from "./src/mcp-registry/requirement-validator.ts";
export type {
  MCPServerMetadata,
  MCPServersRegistry,
  RequiredConfigField,
} from "./src/mcp-registry/schemas.ts";
// MCP Server Pool
export { GlobalMCPServerPool } from "./src/mcp-server-pool.ts";
export type {
  AgentExecutionContext,
  AgentOrchestratorConfig,
  IAgentOrchestrator,
} from "./src/orchestrator/agent-orchestrator.ts";
// Agent Orchestrator
export { AgentOrchestrator } from "./src/orchestrator/agent-orchestrator.ts";
// Session Digest Builder
export {
  buildSessionDigest,
  type DigestError,
  type DigestInput,
  type DigestStep,
  type DigestToolCall,
  type SessionDigest,
} from "./src/session/build-session-digest.ts";
export type { SessionHistoryEventPayload } from "./src/session/fsm-event-mapper.ts";
// FSM Event Mapper
export { mapFsmEventToSessionEvent } from "./src/session/fsm-event-mapper.ts";
// Session History Storage
export * from "./src/session/history-storage.ts";
// Stream Emitters
export {
  CallbackStreamEmitter,
  CancellationNotificationSchema,
  MCPStreamEmitter,
} from "./src/streaming/stream-emitters.ts";
// Actor Types
export * from "./src/types/actors.ts";
// Export error types explicitly
export type {
  APIErrorCause,
  ErrorCause,
  NetworkErrorCause,
  UnknownErrorCause,
} from "./src/types/error-causes.ts";
// Outline Reference schemas for standardized agent outline updates
export {
  type OutlineRef,
  OutlineRefSchema,
  type OutlineRefsResult,
  OutlineRefsResultSchema,
} from "./src/types/outline-ref.ts";
export {
  createErrorCause,
  isAPIErrorCause,
  throwWithCause,
} from "./src/utils/error-helpers.ts";
