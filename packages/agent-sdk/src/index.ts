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
  CompletedAgentResult,
} from "./adapter.ts";
// Core API
export { createAgent } from "./create-agent.ts";
export type {
  AtlasDataEvents,
  AtlasUIMessage,
  AtlasUIMessageChunk,
  AtlasUIMessagePart,
  MessageMetadata,
} from "./messages.ts";
// Messages
export {
  AtlasDataEventSchemas,
  MessageMetadataSchema,
  validateAtlasUIMessages,
} from "./messages.ts";
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
  AgentTelemetryConfig,
  ArtifactRef,
  AtlasAgent,
  AtlasAgentConfig,
  AtlasTool,
  AtlasTools,
  CreateAgentConfig,
  LinkCredentialRef,
  MCPAuthConfig,
  MCPServerConfig,
  MCPServerToolFilter,
  MCPTransportConfig,
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
  ArtifactRefSchema,
  AtlasAgentConfigSchema,
  CreateAgentConfigValidationSchema,
  LinkCredentialRefSchema,
  MCPAuthConfigSchema,
  MCPServerConfigSchema,
  MCPServerToolFilterSchema,
  MCPTransportConfigSchema,
} from "./types.ts";
// Vercel AI SDK helpers
export { repairJson } from "./vercel-helpers/json-repair.ts";
