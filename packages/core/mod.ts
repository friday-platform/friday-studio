/**
 * @atlas/core - Core Atlas functionality
 *
 * This package provides the core workspace management functionality for Atlas.
 */

// Workspace functionality moved to @atlas/workspace package

export type { WrappedAgentResult } from "./src/agent-conversion/from-llm.ts";
// Export strongly-typed LLM converter directly to preserve WrappedAgentResult generic
export { convertLLMToAgent } from "./src/agent-conversion/from-llm.ts";
export type { LLMAgentConfig } from "./src/agent-conversion/index.ts";

// Agent Conversion Layer
export { convertLLMAgentToSDK } from "./src/agent-conversion/index.ts";

// Agent Loader and Registry
export {
  AgentLoader,
  AgentRegistry,
} from "./src/agent-loader/index.ts";
export * from "./src/agent-server/mod.ts";
// Atlas Configuration
export {
  getAtlasBaseUrl,
  getCredentialsApiUrl,
  getDiagnosticsApiUrl,
} from "./src/atlas-config.ts";
// Conversation Storage
export { conversationStorage } from "./src/chat-storage.ts";
export * from "./src/constants/supervisor-status.ts";
// Credential Fetcher
export * from "./src/credential-fetcher.ts";
// Export all LLM provider types and interfaces
export type { LLMOptions, LLMResponse } from "./src/llm-provider.ts";
export { LLMProvider } from "./src/llm-provider.ts";
export type { MCPDiscoveryRequest, MCPServerMetadata } from "./src/mcp-registry/index.ts";
// MCP Registry
export { MCPRegistry } from "./src/mcp-registry/index.ts";
// MCP Server Pool
export { GlobalMCPServerPool } from "./src/mcp-server-pool.ts";
export type {
  AgentExecutionContext,
  AgentOrchestratorConfig,
  ApprovalDecision,
  IAgentOrchestrator,
} from "./src/orchestrator/agent-orchestrator.ts";
// Agent Orchestrator
export { AgentOrchestrator } from "./src/orchestrator/agent-orchestrator.ts";
// Source Attribution helpers
export {
  ensureSourceAttributionProtocol,
  SOURCE_ATTRIBUTION_PROTOCOL_HEADER,
  stripSourceAttributionTags,
} from "./src/prompts/source-attribution.ts";
// Stream Emitters
export {
  CallbackStreamEmitter,
  HTTPStreamEmitter,
  MCPStreamEmitter,
} from "./src/streaming/stream-emitters.ts";
// Todo Storage
export { todoStorage } from "./src/todo-list.ts";
// Actor Types
export * from "./src/types/actors.ts";
// Actor Types
export * from "./src/types/actors.ts";
export * from "./src/types/agent-execution.ts";
export * from "./src/types/session.ts";
