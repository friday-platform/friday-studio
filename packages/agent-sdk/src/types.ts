/**
 * Atlas Agent SDK Core Types
 *
 * Types for building agents that handle natural language prompts.
 * Used by TypeScript agents.
 */

import type { Logger } from "@atlas/logger";
import type { Tracer } from "@opentelemetry/api";
import type {
  InferUITools,
  Tool,
  TypedToolCall,
  TypedToolResult,
  UIDataTypes,
  UIMessage,
  UIMessageChunk,
  UIMessagePart,
} from "ai";
import { z } from "zod";

// ==============================================================================
// BASE UTILITY SCHEMAS
// ==============================================================================

/**
 * Duration format validation (e.g., "30s", "5m", "2h")
 */
export const DurationSchema = z
  .string()
  .regex(/^\d+[smh]$/, {
    message: "Duration must be in format: number + s/m/h (e.g., '30s', '5m', '2h')",
  });
export type Duration = z.infer<typeof DurationSchema>;

/**
 * Allow/Deny filter with mutual exclusion validation
 */
export const AllowDenyFilterSchema = z
  .strictObject({ allow: z.array(z.string()).optional(), deny: z.array(z.string()).optional() })
  .refine((data) => !(data.allow && data.deny), {
    message: "Cannot specify both allow and deny lists",
  });
export type AllowDenyFilter = z.infer<typeof AllowDenyFilterSchema>;

/**
 * Workspace timeout configuration schema
 */
export const WorkspaceTimeoutConfigSchema = z.strictObject({
  progressTimeout: DurationSchema.default("2m").describe(
    "Time allowed between progress signals before cancelling for inactivity",
  ),
  maxTotalTimeout: DurationSchema.default("30m").describe("Hard upper limit for any operation"),
});
export type WorkspaceTimeoutConfig = z.infer<typeof WorkspaceTimeoutConfigSchema>;

// ==============================================================================
// MCP TRANSPORT AND AUTH
// ==============================================================================

/**
 * MCP transport configuration
 */
const MCPTransportStdioSchema = z.strictObject({
  type: z.literal("stdio"),
  command: z.string(),
  args: z.array(z.string()).optional(),
});

const MCPTransportHTTPSchema = z.strictObject({ type: z.literal("http"), url: z.url() });

const MCPTransportSSESchema = z.strictObject({ type: z.literal("sse"), url: z.url() });

export const MCPTransportConfigSchema = z.discriminatedUnion("type", [
  MCPTransportStdioSchema,
  MCPTransportHTTPSchema,
  MCPTransportSSESchema,
]);
export type MCPTransportConfig = z.infer<typeof MCPTransportConfigSchema>;

/**
 * MCP authentication configuration
 */
export const MCPAuthConfigSchema = z.strictObject({
  type: z.enum(["bearer", "api_key", "basic"]),
  header: z.string().optional().describe("Header name for the token"),
  token_env: z.string().optional().describe("Environment variable containing the token"),
  username_env: z.string().optional().describe("For basic auth"),
  password_env: z.string().optional().describe("For basic auth"),
});
export type MCPAuthConfig = z.infer<typeof MCPAuthConfigSchema>;

/**
 * Tool filter for MCP servers - which tools to allow/deny
 */
export const MCPServerToolFilterSchema = AllowDenyFilterSchema.describe(
  "Filter which tools to allow or deny from this MCP server",
);
export type MCPServerToolFilter = z.infer<typeof MCPServerToolFilterSchema>;

/**
 * Individual MCP server configuration
 */
export const MCPServerConfigSchema = z.strictObject({
  transport: MCPTransportConfigSchema,
  client_config: z.strictObject({ timeout: WorkspaceTimeoutConfigSchema.optional() }).optional(),
  auth: MCPAuthConfigSchema.optional(),
  tools: MCPServerToolFilterSchema.optional(),
  env: z
    .record(z.string(), z.string())
    .optional()
    .describe("Environment variables for the server process"),
});
export type MCPServerConfig = z.infer<typeof MCPServerConfigSchema>;

/** Agent expertise - used for discovery & task matching */
export const AgentExpertiseSchema = z.object({
  domains: z
    .array(z.string())
    .min(1)
    .meta({ description: "Domains of expertise.", examples: ["Slack", "Web Research"] }),
  examples: z.array(z.string()).meta({ description: "Example prompts for users" }),
});

export type AgentExpertise = z.infer<typeof AgentExpertiseSchema>;

/** Agent metadata - stored in Atlas registry for discovery */
export const AgentMetadataSchema = z.object({
  id: z
    .string()
    .regex(/^[a-z0-9-]+$/, { message: "Agent name must be lowercase with hyphens" })
    .meta({ description: "Agent ID" }),
  displayName: z.string().optional().meta({ description: "Agent display name" }),
  version: z.string().meta({ description: "Agent version" }),
  description: z.string().min(1).meta({ description: "What this agent does" }),
  expertise: AgentExpertiseSchema,
  inputSchema: z
    .any()
    .optional()
    .meta({ description: "Optional input schema for structured input" }),
});

export type AgentMetadata = z.infer<typeof AgentMetadataSchema>;

/** MCP server config - same format as workspace MCP servers */
export type AgentMCPServerConfig = MCPServerConfig;

/** Environment variables needed by an agent */
export const AgentEnvironmentConfigSchema = z.object({
  required: z
    .array(
      z.object({
        name: z.string().min(1, { message: "Environment variable name is required" }),
        description: z.string().min(1, { message: "Environment variable description is required" }),
        validation: z
          .string()
          .optional()
          .refine(
            (val: string | undefined) => {
              if (!val) return true;
              try {
                new RegExp(val);
                return true;
              } catch {
                return false;
              }
            },
            { message: "Invalid validation regex pattern" },
          ),
      }),
    )
    .optional(),
  optional: z
    .array(
      z.object({
        name: z.string().min(1, { message: "Environment variable name is required" }),
        description: z.string().optional(),
        default: z.string().optional(),
      }),
    )
    .optional(),
});

export type AgentEnvironmentConfig = z.infer<typeof AgentEnvironmentConfigSchema>;

/** LLM settings for configuration-based agents (TypeScript agents bring their own) */
export const AgentLLMConfigSchema = z.object({
  provider: z
    .enum(["anthropic", "openai", "google"], {
      message: "Provider must be 'anthropic', 'openai', or 'google'",
    })
    .optional(),
  model: z.string().optional(),
  temperature: z
    .number()
    .min(0, { message: "Temperature must be at least 0" })
    .max(2, { message: "Temperature must be at most 2" })
    .optional(),
  max_tokens: z.number().positive({ message: "Max tokens must be a positive number" }).optional(),
});

export type AgentLLMConfig = z.infer<typeof AgentLLMConfigSchema>;

/**
 * Atlas tool type - directly uses AI SDK Tool for zero-conversion compatibility
 *
 * This is a re-export of the AI SDK Tool type, ensuring that tools from MCP
 * can be used directly with AI SDK without any conversion or wrapping.
 */
export type AtlasTool = Tool;
export type AtlasTools = Record<string, AtlasTool>;

/** Tool execution context from MCP calls */
export interface ToolContext {
  toolCallId: string;
  messages: Array<{ role: string; content: string }>;
}

/** Tool execution result from agent runs */
export type ToolResult = TypedToolResult<AtlasTools>;
export type ToolCall = TypedToolCall<AtlasTools>;

export const MessageMetadataSchema = z.object({
  agentId: z.string().optional(),
  sessionId: z.string().optional(),
});

export type MessageMetadata = z.infer<typeof MessageMetadataSchema>;

/**
 * @HACK: `data-user-message` this is a workaround since the AI SDK doesn't
 * give you a way to emit user messages back to the stream. It expects that
 * they will be just pushed to the array and persisted client-side.
 */
type UserMessageEvent = {
  "user-message": { content: string };
  "tool-progress": { toolName: string; content: string };
};

export type AtlasUIMessage<T extends UIDataTypes = UIDataTypes> = UIMessage<
  MessageMetadata,
  T & UserMessageEvent
>;
export type AtlasUIMessageChunk<T extends UIDataTypes = UIDataTypes> = UIMessageChunk<
  MessageMetadata,
  T & UserMessageEvent
>;

export type AtlasUIMessagePart<T extends UIDataTypes = UIDataTypes> = UIMessagePart<
  T & UserMessageEvent,
  InferUITools<AtlasTools>
>;

/** Stream emitter passed to agent handlers */
export interface StreamEmitter<T extends AtlasUIMessageChunk = AtlasUIMessageChunk> {
  emit: (event: T) => void;
  end: () => void | Promise<void>;
  error: (error: Error) => void;
}

/** Atlas session data from request headers */
export const AgentSessionDataSchema = z.object({
  sessionId: z.string(),
  workspaceId: z.string(),
  userId: z.string().optional(),
  streamId: z.string().optional(),
});

export type AgentSessionData = z.infer<typeof AgentSessionDataSchema>;

/**
 * Telemetry configuration for agent execution.
 * Compatible with AI SDK's experimental_telemetry option.
 * @see https://ai-sdk.dev/docs/ai-sdk-core/telemetry
 */
export interface AgentTelemetryConfig {
  /** OpenTelemetry tracer for span collection */
  tracer: Tracer;
  /** Whether to record agent input/output data */
  recordInputs: boolean;
  recordOutputs: boolean;
}

/**
 * Context passed to agent handlers
 *
 * Contains everything agents need: tools, environment, streaming, logging.
 * Built by AtlasAgentsMCPServer before calling agent.execute().
 * Memory context is handled transparently by enriching the prompt.
 */
export interface AgentContext {
  /** All available tools from all servers (unified access) */
  tools: AtlasTools;

  /** Session info (workspace, user, etc.) */
  session: AgentSessionData;

  /** Environment variables validated at execution time */
  env: Record<string, string>;

  /** Agent configuration from workspace.yml or atlas.yml */
  config?: Record<string, unknown>;

  /** Stream events back to Atlas - always provided */
  stream: StreamEmitter | undefined;

  /** Logger instance with session context pre-configured */
  logger: Logger;

  /** Optional abort signal for cancelling agent execution */
  abortSignal?: AbortSignal;

  /** Optional telemetry configuration for observability */
  telemetry?: AgentTelemetryConfig;
}

/**
 * Agent handler function - receives input and context
 *
 * This is where agents interpret requests and decide what to do.
 * Input can be a string prompt or structured data based on inputSchema.
 */
export type AgentHandler<TInput = string, TOutput = unknown> = (
  input: TInput,
  context: AgentContext,
) => Promise<TOutput>;

/**
 * Config for createAgent() function
 *
 * TypeScript interface because handler functions can't be validated with Zod.
 * Use CreateAgentConfigValidationSchema for validating the non-function parts.
 */
export interface CreateAgentConfig<TInput = string, TOutput = unknown> extends AgentMetadata {
  /** Optional input schema for structured input validation */
  inputSchema?: z.ZodSchema<TInput>;

  /** Handler that processes all prompts for this agent */
  handler: AgentHandler<TInput, TOutput>;

  /** Environment variables this agent needs */
  environment?: AgentEnvironmentConfig;

  /** MCP servers this agent uses */
  mcp?: Record<string, AgentMCPServerConfig>;

  /** LLM config (unused by TypeScript agents) */
  llm?: AgentLLMConfig;
}

/** Zod validation for createAgent() config (excluding handler function) */
export const CreateAgentConfigValidationSchema = AgentMetadataSchema.extend({
  environment: AgentEnvironmentConfigSchema.optional(),
  mcp: z.record(z.string(), MCPServerConfigSchema).optional(),
  llm: AgentLLMConfigSchema.optional(),
});

/**
 * Atlas Agent instance
 *
 * Created by createAgent() function.
 * Stored in registry and executed by AtlasAgentsMCPServer.
 */
export interface AtlasAgent<TInput = string, TOutput = unknown> {
  /** Agent metadata for registry */
  metadata: AgentMetadata;

  /** Execute agent with input (string or structured based on inputSchema) */
  execute(input: TInput, context: AgentContext): Promise<TOutput>;

  /** Environment config (used by server for validation) */
  readonly environmentConfig: AgentEnvironmentConfig | undefined;

  /** MCP server config (used by server for tool access) */
  readonly mcpConfig: Record<string, AgentMCPServerConfig> | undefined;

  /** LLM config (used by configuration-based agents only) */
  readonly llmConfig: AgentLLMConfig | undefined;
}

/** Agent session state - persisted between executions */
export const AgentSessionStateSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  memory: z.record(z.string(), z.unknown()),
  lastExecution: z
    .object({ prompt: z.string(), timestamp: z.number(), result: z.unknown().optional() })
    .optional(),
});

export type AgentSessionState = z.infer<typeof AgentSessionStateSchema>;

/** Approval request for supervisor decision */
export const ApprovalRequestSchema = z.object({
  action: z.string(),
  risk_level: z.enum(["low", "medium", "high", "critical"]),
  context: z.object({
    resource: z.string().optional(),
    environment: z.string().optional(),
    impact: z.string().optional(),
    reversible: z.boolean().optional(),
  }),
  rationale: z.string(),
});

export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;

/**
 * Exception thrown by request_supervisor_approval tool
 *
 * Suspends agent execution until supervisor makes decision.
 * Caught by AtlasAgentsMCPServer and forwarded to session supervisor.
 */
export class AwaitingSupervisorDecision extends Error {
  constructor(
    public readonly approvalId: string,
    public readonly request: ApprovalRequest,
    public readonly sessionId: string,
    public readonly agentId: string,
  ) {
    super("Awaiting supervisor decision");
    this.name = "AwaitingSupervisorDecision";
  }
}

/** Agent registry - used by AtlasAgentsMCPServer for agent management */
export interface AgentRegistry {
  listAgents(filters?: { domains?: string[]; tags?: string[] }): Promise<AgentMetadata[]>;

  getAgent(id: string): Promise<AtlasAgent | undefined>;

  registerAgent(agent: AtlasAgent): Promise<void>;

  searchAgents(query: string): Promise<AgentMetadata[]>;

  getAgentsByDomain(domain: string): Promise<AgentMetadata[]>;
}

/**
 * Atlas Agent configuration schema for workspace.yml
 *
 * @example
 * ```yaml
 * agents:
 *   github:
 *     type: "atlas"
 *     agent: "github"
 *     description: "GitHub operations - PRs, issues, code scanning"
 *     version: "1.0.0"
 *     config:
 *       default_patterns: ["eval(", "innerHTML"]
 *       auto_merge_checks: ["tests", "security", "lint"]
 *     environment:
 *       GITHUB_TOKEN: "${GITHUB_TOKEN}"
 * ```
 */
export const AtlasAgentConfigSchema = z.object({
  type: z.literal("atlas"),
  agent: z.string().describe("Atlas Agent ID from registry"),
  description: z.string().describe("Agent description"),
  prompt: z.string().describe("Agent prompt"),
  // version: z.string().optional().describe("Agent version (defaults to latest)"),
  // config: z
  //   .record(z.string(), z.unknown())
  //   .optional()
  //   .describe("Agent-specific configuration passed to the agent"),
  //
  env: z
    .record(z.string(), z.string())
    .optional()
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Explanation of how env variables can be formatted.
    .meta({ description: "Environment variables for the agent (supports ${VAR} interpolation)" }),
});

export type AtlasAgentConfig = z.infer<typeof AtlasAgentConfigSchema>;

// ==============================================================================
// AGENT EXECUTION RESULTS
// ==============================================================================

/**
 * Artifact reference with metadata
 *
 * Used when agents create or reference artifacts.
 * Includes ID for lookup, type for categorization, and summary for context.
 */
export const ArtifactRefSchema = z.object({
  id: z.string().describe("Artifact ID"),
  type: z.string().describe("Artifact type (e.g., document, code, data)"),
  summary: z.string().describe("Brief summary of artifact contents and purpose"),
});

export type ArtifactRef = z.infer<typeof ArtifactRefSchema>;

/**
 * Result from agent execution - consolidated interface used across Atlas
 *
 * Contains execution metadata, timing, and tool usage information.
 * Used by hallucination detector, orchestrator, and session supervisors.
 */
export interface AgentResult {
  /** Agent identifier */
  agentId: string;
  /** Task or prompt that was executed */
  task: string;
  /** Input provided to the agent */
  input: unknown;
  /** Output produced by the agent */
  output: unknown;
  /** Model or agent reasoning text, when available */
  reasoning?: string;
  /** Error message if execution failed */
  error?: string;
  /** Execution duration in milliseconds */
  duration: number;
  /** ISO timestamp of execution */
  timestamp: string;
  /** Tool calls made during execution */
  toolCalls?: ToolCall[];
  /** Results from tool executions */
  toolResults?: ToolResult[];
  /** Memory context (optional, used by some services) */
  memory?: unknown[];
  /** Artifact references with full metadata (id, type, summary) */
  artifactRefs?: ArtifactRef[];
}
