/**
 * Atlas Agent SDK
 *
 * Build agents that handle natural language prompts.
 * Agents access MCP tools, environment variables, and streaming.
 */

// Adapter interfaces for server implementations
export type {
  AgentExecutionResult,
  AgentServerAdapter,
  AgentSessionManager,
  AwaitingApprovalResult,
  CompletedAgentResult,
} from "./adapter.ts";
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
  AtlasUIMessage,
  AtlasUIMessageChunk,
  CreateAgentConfig,
  MCPAuthConfig,
  MCPServerConfig,
  MCPServerToolFilter,
  MCPTransportConfig,
  MessageMetadata,
  StreamEmitter,
  ToolCall,
  ToolContext,
  ToolResult,
} from "./types.ts";
// Zod Schemas for runtime validation
// Exceptions
export {
  AgentEnvironmentConfigSchema,
  AgentExpertiseSchema,
  AgentLLMConfigSchema,
  AgentMetadataSchema,
  AgentSessionDataSchema,
  AgentSessionStateSchema,
  ApprovalRequestSchema,
  AtlasAgentConfigSchema,
  AwaitingSupervisorDecision,
  CreateAgentConfigValidationSchema,
  MCPAuthConfigSchema,
  MCPServerConfigSchema,
  MCPServerToolFilterSchema,
  MCPTransportConfigSchema,
  MessageMetadataSchema,
} from "./types.ts";
