/**
 * @atlas/core - Core Atlas functionality
 *
 * This package provides the core workspace management functionality for Atlas.
 */

// Workspace functionality moved to @atlas/workspace package

// Export all LLM provider types and interfaces
export type { LLMOptions, LLMResponse } from "./src/llm-provider.ts";
export { LLMProvider } from "./src/llm-provider.ts";

// MCP Server Pool
export { GlobalMCPServerPool } from "./src/mcp-server-pool.ts";

// Credential Fetcher
export {
  CredentialFetcher,
  type Credentials,
  type FetchCredentialsOptions,
} from "./src/credential-fetcher.ts";

// Atlas Configuration
export { getAtlasBaseUrl, getCredentialsApiUrl, getDiagnosticsApiUrl } from "./src/atlas-config.ts";

// Actor Types
export * from "./src/types/actors.ts";
export * from "./src/types/agent-execution.ts";
export * from "./src/types/xstate-events.ts";
export * from "./src/types/xstate-contexts.ts";
export * from "./src/constants/supervisor-status.ts";

// Stream Emitters
export {
  CallbackStreamEmitter,
  HTTPStreamEmitter,
  MCPStreamEmitter,
  NoOpStreamEmitter,
} from "./src/streaming/stream-emitters.ts";

// AI to SSE Stream Converter
export {
  convertAIStreamToSSE,
  createRequestEvent,
  resetStreamIdTracker,
} from "./src/streaming/ai-to-sse-converter.ts";

export * from "./src/agent-server/mod.ts";

// Agent Orchestrator
export { AgentOrchestrator } from "./src/orchestrator/index.ts";
export type {
  AgentExecutionContext,
  AgentOrchestratorConfig,
  AgentResult,
  ApprovalDecision,
  IAgentOrchestrator,
} from "./src/orchestrator/index.ts";

// Agent Conversion Layer
export {
  convertLLMAgentToSDK,
  convertLLMToAgent,
  convertYAMLAgentToSDK,
  convertYAMLToAgent,
} from "./src/agent-conversion/index.ts";
export type { LLMAgentConfig, YAMLAgentDefinition } from "./src/agent-conversion/index.ts";

// Agent Loader and Registry
export { AgentLoader, AgentRegistry } from "./src/agent-loader/index.ts";
