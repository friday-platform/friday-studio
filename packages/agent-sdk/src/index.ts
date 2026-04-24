export type { AgentServerAdapter, AgentSessionManager } from "./adapter.ts";
// SQLite-backed stores are NOT re-exported from the top-level barrel —
// they pull `@db/sqlite` (FFI) which can't run in the browser. The web
// client and playground transitively import this package via
// @atlas/skills/schemas → @atlas/config → here, so any runtime sqlite
// import would leak FFI into the browser bundle. Same gotcha CLAUDE.md
// flags for @atlas/core.
//
// Consumers needing the sqlite backends import them from the subpath:
//   import { SqliteRetrievalStore } from "@atlas/agent-sdk/backends";
export type { SqliteRagConfig } from "./backends/index.ts";
export {
  type ClosePendingToolPartsResult,
  closePendingToolParts,
} from "./close-pending-tool-parts.ts";
export { createAgent } from "./create-agent.ts";
export type { CreateFailToolOptions, FailInput } from "./fail-tool.ts";
export { createFailTool, FailInputSchema } from "./fail-tool.ts";
export * from "./memory-adapter.ts";
export * from "./memory-scope.ts";
export type {
  AtlasDataEvent,
  AtlasDataEvents,
  AtlasUIMessage,
  AtlasUIMessageChunk,
  AtlasUIMessagePart,
  MessageMetadata,
} from "./messages.ts";
export {
  AtlasDataEventSchema,
  AtlasDataEventSchemas,
  MemoryRollbackEventSchema,
  MemoryWriteEventSchema,
  MessageMetadataSchema,
  ScratchpadWriteEventSchema,
  SkillRollbackEventSchema,
  SkillWriteEventSchema,
  validateAtlasUIMessages,
} from "./messages.ts";
export { normalizeToUIMessages } from "./normalize-to-ui-messages.ts";
export { createPlatformTools, PLATFORM_TOOL_NAMES } from "./platform-tools.ts";
export * from "./resolved-memory.ts";
export type { ResourceToolkit } from "./resource-toolkit.ts";
export {
  createResourceLinkRefTool,
  createResourceReadTool,
  createResourceSaveTool,
  createResourceWriteTool,
} from "./resource-tools.ts";
export type {
  AgentExtras,
  AgentPayload,
  AgentPayloadError,
  AgentPayloadSuccess,
} from "./result.ts";
export { err, ok } from "./result.ts";
// Schema boundary
export type { SchemaBoundaryConfig } from "./schema-boundary.ts";
export { withSchemaBoundary } from "./schema-boundary.ts";
export * from "./scratchpad-adapter.ts";
export * from "./skill-adapter.ts";
export type {
  AgentContext,
  AgentEnvironmentConfig,
  AgentExecutionError,
  AgentExecutionSuccess,
  AgentExpertise,
  AgentHandler,
  AgentLLMConfig,
  AgentMCPServerConfig,
  AgentMemoryContext,
  AgentMetadata,
  AgentRegistry,
  AgentResult,
  AgentSessionData,
  AgentSessionState,
  AgentSkill,
  AgentTelemetryConfig,
  ArtifactRef,
  AtlasAgent,
  AtlasAgentConfig,
  AtlasTool,
  AtlasTools,
  CreateAgentConfig,
  LinkCredentialRef,
  LogContext,
  Logger,
  MCPAuthConfig,
  MCPServerConfig,
  MCPServerToolFilter,
  MCPTransportConfig,
  OutlineRef,
  StoreMountBinding,
  StreamEmitter,
  ToolCall,
  ToolContext,
  ToolProgress,
  ToolResult,
} from "./types.ts";
export {
  AgentEnvironmentConfigSchema,
  AgentExecutionErrorSchema,
  AgentExecutionSuccessSchema,
  AgentExpertiseSchema,
  AgentLLMConfigSchema,
  AgentMetadataSchema,
  AgentResultSchema,
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
  OutlineRefSchema,
} from "./types.ts";
export { repairJson, repairToolCall } from "./vercel-helpers/json-repair.ts";
