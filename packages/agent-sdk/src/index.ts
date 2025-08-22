/**
 * Atlas Agent SDK
 *
 * Build agents that handle natural language prompts.
 * Agents access MCP tools, environment variables, and streaming.
 */

// Core API
export { createAgent } from "./create-agent.ts";

// Types
export type {
  AgentContext,
  AgentEnvironmentConfig,
  AgentExpertise,
  AgentHandler,
  AgentLLMConfig,
  AgentMCPServerConfig,
  AgentMetadata,
  AgentRegistry,
  AgentResult,
  AgentSessionData,
  AgentSessionState,
  ApprovalRequest,
  AtlasAgent,
  AtlasAgentConfig,
  AtlasTool,
  AtlasTools,
  CreateAgentConfig,
  MCPAuthConfig,
  MCPServerConfig,
  MCPServerToolFilter,
  MCPTransportConfig,
  StreamEmitter,
  StreamEvent,
  ToolCall,
  ToolContext,
  ToolResult,
} from "./types.ts";

// Zod Schemas for runtime validation
export {
  AgentEnvironmentConfigSchema,
  AgentExpertiseSchema,
  AgentLLMConfigSchema,
  AgentMetadataSchema,
  AgentSessionDataSchema,
  AgentSessionStateSchema,
  ApprovalRequestSchema,
  AtlasAgentConfigSchema,
  CreateAgentConfigValidationSchema,
  MCPAuthConfigSchema,
  MCPServerConfigSchema,
  MCPServerToolFilterSchema,
  MCPTransportConfigSchema,
  StreamEventSchema,
} from "./types.ts";

// Exceptions
export { AwaitingSupervisorDecision } from "./types.ts";

// Adapter interfaces for server implementations
export type {
  AgentExecutionResult,
  AgentServerAdapter,
  AgentSessionManager,
  AwaitingApprovalResult,
  CompletedAgentResult,
} from "./adapter.ts";
