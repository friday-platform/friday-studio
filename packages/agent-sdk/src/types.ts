import type { Tracer } from "@opentelemetry/api";
import type { Tool, TypedToolCall, TypedToolResult } from "ai";
import { z } from "zod";
import type { AtlasUIMessage, AtlasUIMessageChunk, AtlasUIMessagePart } from "./messages.ts";
import type { AgentPayload } from "./result.ts";

export type { AtlasUIMessage, AtlasUIMessageChunk, AtlasUIMessagePart };

// ==============================================================================
// LOGGER TYPES
// ==============================================================================

/** Context attached to log entries */
export interface LogContext {
  workspaceId?: string;
  sessionId?: string;
  agentId?: string;
  workerType?: string;
  agentName?: string;
  supervisorId?: string;
  workerId?: string;
  error?: unknown;
  [key: string]: unknown;
}

/** Logger interface — matches @atlas/logger contract */
export interface Logger {
  trace(message: string, context?: LogContext): void;
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;
  fatal(message: string, context?: LogContext): void;
  child(context: LogContext): Logger;
}

// ==============================================================================
// BASE UTILITY SCHEMAS
// ==============================================================================

export const DurationSchema = z
  .string()
  .regex(/^\d+[smh]$/, {
    message: "Duration must be in format: number + s/m/h (e.g., '30s', '5m', '2h')",
  });
export type Duration = z.infer<typeof DurationSchema>;

export const AllowDenyFilterSchema = z
  .strictObject({ allow: z.array(z.string()).optional(), deny: z.array(z.string()).optional() })
  .refine((data) => !(data.allow && data.deny), {
    message: "Cannot specify both allow and deny lists",
  });
export type AllowDenyFilter = z.infer<typeof AllowDenyFilterSchema>;

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

const MCPTransportStdioSchema = z.strictObject({
  type: z.literal("stdio"),
  command: z.string(),
  args: z.array(z.string()).optional(),
});

const MCPTransportHTTPSchema = z.strictObject({ type: z.literal("http"), url: z.url() });

export const MCPTransportConfigSchema = z.discriminatedUnion("type", [
  MCPTransportStdioSchema,
  MCPTransportHTTPSchema,
]);
export type MCPTransportConfig = z.infer<typeof MCPTransportConfigSchema>;

export const MCPAuthConfigSchema = z.strictObject({
  type: z.literal("bearer"),
  token_env: z.string().optional().describe("Environment variable containing the token"),
});
export type MCPAuthConfig = z.infer<typeof MCPAuthConfigSchema>;

export const MCPServerToolFilterSchema = AllowDenyFilterSchema.describe(
  "Filter which tools to allow or deny from this MCP server",
);
export type MCPServerToolFilter = z.infer<typeof MCPServerToolFilterSchema>;

/** Retrieves secrets from Link service */
export const LinkCredentialRefSchema = z
  .strictObject({
    from: z.literal("link"),
    id: z.string().min(1).optional().describe("Link credential ID (e.g., 'cred_abc123')"),
    provider: z.string().min(1).optional().describe("Provider name (e.g., 'github', 'slack')"),
    key: z.string().describe("Key within credential.secret object (e.g., 'token')"),
  })
  .refine((data) => Boolean(data.id) || Boolean(data.provider), {
    message: "At least one of 'id' or 'provider' must be specified",
  });
export type LinkCredentialRef = z.infer<typeof LinkCredentialRefSchema>;

const EnvValueSchema = z.union([z.string(), LinkCredentialRefSchema]);

export const MCPServerConfigSchema = z.strictObject({
  transport: MCPTransportConfigSchema,
  client_config: z.strictObject({ timeout: WorkspaceTimeoutConfigSchema.optional() }).optional(),
  auth: MCPAuthConfigSchema.optional(),
  tools: MCPServerToolFilterSchema.optional(),
  env: z
    .record(z.string(), EnvValueSchema)
    .optional()
    .describe("Environment variables for the server process"),
});
export type MCPServerConfig = z.infer<typeof MCPServerConfigSchema>;

/** Agent expertise - used for discovery & task matching */
export const AgentExpertiseSchema = z.object({
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
  constraints: z
    .string()
    .optional()
    .meta({ description: "Human-readable limitations or restrictions on agent capabilities" }),
  expertise: AgentExpertiseSchema,
  inputSchema: z
    .any()
    .optional()
    .meta({ description: "Optional input schema for structured input" }),
  outputSchema: z
    .any()
    .optional()
    .meta({ description: "Optional output schema for structured output" }),
});

export type AgentMetadata = z.infer<typeof AgentMetadataSchema>;

/** MCP server config - same format as workspace MCP servers */
export type AgentMCPServerConfig = MCPServerConfig;

/** Like LinkCredentialRefSchema but without `from: "link"` - field name provides context */
const SimpleLinkRefSchema = z.strictObject({
  provider: z.string().describe("Provider name (e.g., 'slack', 'github')"),
  key: z.string().describe("Key within credential.secret object (e.g., 'access_token')"),
});

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
        linkRef: SimpleLinkRefSchema.optional().describe(
          "Link credential reference for automatic resolution",
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

/** Re-export of AI SDK Tool - MCP tools work without conversion */
export type AtlasTool = Tool;
export type AtlasTools = Record<string, AtlasTool>;

export interface ToolContext {
  toolCallId: string;
  messages: Array<{ role: string; content: string }>;
}

export type ToolResult = TypedToolResult<AtlasTools>;
export type ToolCall = TypedToolCall<AtlasTools>;

export interface StreamEmitter<T extends AtlasUIMessageChunk = AtlasUIMessageChunk> {
  emit: (event: T) => void;
  end: () => void | Promise<void>;
  error: (error: Error) => void;
}

export const AgentSessionDataSchema = z.object({
  sessionId: z.string(),
  workspaceId: z.string(),
  userId: z.string().optional(),
  streamId: z.string().optional(),
  datetime: z
    .object({
      timezone: z.string(),
      timestamp: z.string(),
      localDate: z.string(),
      localTime: z.string(),
      timezoneOffset: z.string(),
    })
    .optional(),
});

export type AgentSessionData = z.infer<typeof AgentSessionDataSchema>;

/** @see https://ai-sdk.dev/docs/ai-sdk-core/telemetry */
export interface AgentTelemetryConfig {
  tracer: Tracer;
  recordInputs: boolean;
  recordOutputs: boolean;
}

/** Resolved workspace skill passed to agent handlers */
export interface AgentSkill {
  name: string;
  description: string;
  instructions: string;
}

/** Built by AtlasAgentsMCPServer before agent.execute() */
export interface AgentContext {
  tools: AtlasTools;
  session: AgentSessionData;
  env: Record<string, string>;
  config?: Record<string, unknown>;
  /** JSON Schema for structured output. When provided, agents should use it to return validated data. */
  outputSchema?: Record<string, unknown>;
  /** Workspace skills resolved for the agent (when useWorkspaceSkills is true) */
  skills?: AgentSkill[];
  stream: StreamEmitter | undefined;
  logger: Logger;
  abortSignal?: AbortSignal;
  telemetry?: AgentTelemetryConfig;
}

/** Returns AgentPayload<TOutput> via ok()/err(). Execution layer adds metadata. */
export type AgentHandler<TInput = string, TOutput = unknown> = (
  input: TInput,
  context: AgentContext,
) => Promise<AgentPayload<TOutput>>;

/** Interface (not Zod) because handler is a function */
export interface CreateAgentConfig<TInput = string, TOutput = unknown> extends AgentMetadata {
  inputSchema?: z.ZodSchema<TInput>;
  handler: AgentHandler<TInput, TOutput>;
  environment?: AgentEnvironmentConfig;
  mcp?: Record<string, AgentMCPServerConfig>;
  llm?: AgentLLMConfig;

  /** Whether this agent can load workspace skills. Default: false */
  useWorkspaceSkills?: boolean;
}

export const CreateAgentConfigValidationSchema = AgentMetadataSchema.extend({
  environment: AgentEnvironmentConfigSchema.optional(),
  mcp: z.record(z.string(), MCPServerConfigSchema).optional(),
  llm: AgentLLMConfigSchema.optional(),
});

/** Created by createAgent(), stored in registry, executed by AtlasAgentsMCPServer */
export interface AtlasAgent<TInput = string, TOutput = unknown> {
  metadata: AgentMetadata;
  execute(input: TInput, context: AgentContext): Promise<AgentPayload<TOutput>>;
  readonly environmentConfig: AgentEnvironmentConfig | undefined;
  readonly mcpConfig: Record<string, AgentMCPServerConfig> | undefined;
  readonly llmConfig: AgentLLMConfig | undefined;

  /** Whether this agent uses workspace skills */
  readonly useWorkspaceSkills: boolean;
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

/** Agent registry - used by AtlasAgentsMCPServer for agent management */
export interface AgentRegistry {
  listAgents(): Promise<AgentMetadata[]>;

  getAgent(id: string): Promise<AtlasAgent | undefined>;

  registerAgent(agent: AtlasAgent): Promise<void>;
}

/** workspace.yml agent configuration */
export const AtlasAgentConfigSchema = z.strictObject({
  type: z.literal("atlas"),
  agent: z.string().describe("Atlas Agent ID from registry"),
  description: z.string().describe("Agent description"),
  prompt: z.string().describe("Agent prompt"),
  config: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Agent-specific configuration passed to the agent"),
  env: z
    .record(z.string(), z.union([z.string(), LinkCredentialRefSchema]))
    .optional()
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Explanation of how env variables can be formatted.
    .meta({ description: "Environment variables for the agent (supports ${VAR} interpolation)" }),
});

export type AtlasAgentConfig = z.infer<typeof AtlasAgentConfigSchema>;

// ==============================================================================
// AGENT EXECUTION RESULTS
// ==============================================================================

export const ArtifactRefSchema = z.object({
  id: z.string().describe("Artifact ID"),
  type: z.string().describe("Artifact type (e.g., document, code, data)"),
  summary: z.string().describe("Brief summary of artifact contents and purpose"),
});

export type ArtifactRef = z.infer<typeof ArtifactRefSchema>;

/** Structured references displayed in UI outline */
export const OutlineRefSchema = z.object({
  service: z.string().describe("Service identifier (e.g., 'google-calendar', 'slack', 'internal')"),
  title: z.string().describe("Display title for the reference"),
  content: z.string().optional().describe("Optional summary text"),
  artifactId: z.string().optional().describe("Optional associated artifact ID"),
  artifactLabel: z.string().optional().describe("Optional label for the artifact"),
  type: z.string().optional().describe("Optional type discriminator"),
});

export type OutlineRef = z.infer<typeof OutlineRefSchema>;

export const AgentExecutionSuccessSchema = z.object({
  agentId: z.string().describe("Agent identifier"),
  timestamp: z.string().describe("ISO 8601 timestamp of execution"),
  input: z.unknown().describe("Input provided to the agent"),
  ok: z.literal(true).describe("Success discriminant"),
  data: z.unknown().describe("Output produced by the agent"),
  reasoning: z.string().optional().describe("Model or agent reasoning text"),
  // z.any() not z.unknown() - allows z.infer to produce any[] which is assignable to ToolCall[]
  // without type assertions at parse sites. Tradeoff: weaker validation, cleaner consumer code.
  toolCalls: z.array(z.any()).optional().describe("Tool calls made during execution"),
  toolResults: z.array(z.any()).optional().describe("Results from tool executions"),
  artifactRefs: z.array(ArtifactRefSchema).optional().describe("Artifact references"),
  outlineRefs: z.array(OutlineRefSchema).optional().describe("Outline references for UI"),
  durationMs: z.number().describe("Execution duration in milliseconds"),
});

export const AgentExecutionErrorSchema = z.object({
  agentId: z.string().describe("Agent identifier"),
  timestamp: z.string().describe("ISO 8601 timestamp of execution"),
  input: z.unknown().describe("Input provided to the agent"),
  ok: z.literal(false).describe("Failure discriminant"),
  error: z.object({ reason: z.string() }).describe("Error information"),
  durationMs: z.number().describe("Execution duration in milliseconds"),
});

/** Discriminated union on `ok` - use for parsing unknown data */
export const AgentResultSchema = z.discriminatedUnion("ok", [
  AgentExecutionSuccessSchema,
  AgentExecutionErrorSchema,
]);

/**
 * Omit toolCalls/toolResults from Zod and re-add with AI SDK types.
 * Zod uses z.unknown() (loose runtime), TypeScript gets precise types.
 */
export type AgentExecutionSuccess<TInput = unknown, TOutput = unknown> = Omit<
  z.infer<typeof AgentExecutionSuccessSchema>,
  "input" | "data" | "toolCalls" | "toolResults"
> & { input: TInput; data: TOutput; toolCalls?: ToolCall[]; toolResults?: ToolResult[] };

export type AgentExecutionError<TInput = unknown> = Omit<
  z.infer<typeof AgentExecutionErrorSchema>,
  "input"
> & { input: TInput };

/** Discriminated union on `ok` - typed version of AgentResultSchema */
export type AgentResult<TInput = unknown, TOutput = unknown> =
  | AgentExecutionSuccess<TInput, TOutput>
  | AgentExecutionError<TInput>;
