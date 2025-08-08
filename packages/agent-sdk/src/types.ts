/**
 * Atlas Agent SDK Core Types
 *
 * Types for building agents that handle natural language prompts.
 * Used by TypeScript agents.
 */

import { z } from "zod/v4";
import type { Tool } from "ai";
import type { Logger } from "@atlas/logger";

// ==============================================================================
// BASE UTILITY SCHEMAS
// ==============================================================================

/**
 * Duration format validation (e.g., "30s", "5m", "2h")
 */
export const DurationSchema = z.string().regex(/^\d+[smh]$/, {
  message: "Duration must be in format: number + s/m/h (e.g., '30s', '5m', '2h')",
});
export type Duration = z.infer<typeof DurationSchema>;

/**
 * Allow/Deny filter with mutual exclusion validation
 */
export const AllowDenyFilterSchema = z.strictObject({
  allow: z.array(z.string()).optional(),
  deny: z.array(z.string()).optional(),
}).refine(
  (data) => !(data.allow && data.deny),
  { message: "Cannot specify both allow and deny lists" },
);
export type AllowDenyFilter = z.infer<typeof AllowDenyFilterSchema>;

/**
 * Workspace timeout configuration schema
 */
export const WorkspaceTimeoutConfigSchema = z.strictObject({
  progressTimeout: DurationSchema.default("2m").describe(
    "Time allowed between progress signals before cancelling for inactivity",
  ),
  maxTotalTimeout: DurationSchema.default("30m").describe(
    "Hard upper limit for any operation",
  ),
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

const MCPTransportHTTPSchema = z.strictObject({
  type: z.literal("http"),
  url: z.url(),
});

const MCPTransportSSESchema = z.strictObject({
  type: z.literal("sse"),
  url: z.url(),
});

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
  client_config: z.strictObject({
    timeout: WorkspaceTimeoutConfigSchema.optional(),
  }).optional(),
  auth: MCPAuthConfigSchema.optional(),
  tools: MCPServerToolFilterSchema.optional(),
  env: z.record(z.string(), z.string()).optional().describe(
    "Environment variables for the server process",
  ),
});
export type MCPServerConfig = z.infer<typeof MCPServerConfigSchema>;

/** Agent expertise - used by Atlas session supervisor for task matching */
export const AgentExpertiseSchema = z.object({
  /** Domains this agent handles */
  domains: z.array(z.string()).min(1, {
    message: "Agent must specify at least one domain",
  }).describe("Domains this agent handles"),

  /** What the agent can do */
  capabilities: z.array(z.string()).min(1, {
    message: "Agent must specify at least one capability",
  }).describe("What the agent can do"),

  /** Example prompts for users */
  examples: z.array(z.string()).describe("Example prompts for users"),
});

export type AgentExpertise = z.infer<typeof AgentExpertiseSchema>;

/** Agent metadata - stored in Atlas registry for discovery */
export const AgentMetadataSchema = z.object({
  /** Agent ID used for registration and access - lowercase with hyphens and underscores */
  id: z.string().regex(/^[a-z][a-z0-9-_]*$/, {
    message:
      "Invalid agent ID. Must be lowercase and follow domain naming pattern (e.g., 'my-agent', 'github_scanner', 'my_cool_agent')",
  }).describe("Agent ID used for registration and access - lowercase with hyphens and underscores"),

  /** Display name for the agent - human-readable format */
  displayName: z.string().optional().describe(
    "Display name for the agent - human-readable format",
  ),

  /** Semantic version */
  version: z.string().regex(/^\d+\.\d+\.\d+/, {
    message: "Invalid version. Must follow semantic versioning (e.g., '1.0.0', '2.1.3')",
  }).describe("Semantic version"),

  /** What this agent does */
  description: z.string().min(1, {
    message: "Description is required",
  }).describe("What this agent does"),

  /** Agent's domains and capabilities */
  expertise: AgentExpertiseSchema,

  /** Optional tags and author info */
  metadata: z.object({
    tags: z.array(z.string()).optional(),
    author: z.object({
      name: z.string(),
      email: z.email({
        message: "Invalid email format",
      }).optional(),
    }).optional(),
  }).optional(),
});

export type AgentMetadata = z.infer<typeof AgentMetadataSchema>;

/** MCP server config - same format as workspace MCP servers */
export type AgentMCPServerConfig = MCPServerConfig;

/** Environment variables needed by an agent */
export const AgentEnvironmentConfigSchema = z.object({
  required: z.array(z.object({
    name: z.string().min(1, { message: "Environment variable name is required" }),
    description: z.string().min(1, { message: "Environment variable description is required" }),
    validation: z.string().optional().refine(
      (val: string | undefined) => {
        if (!val) return true;
        try {
          new RegExp(val);
          return true;
        } catch {
          return false;
        }
      },
      {
        message: "Invalid validation regex pattern",
      },
    ),
  })).optional(),
  optional: z.array(z.object({
    name: z.string().min(1, { message: "Environment variable name is required" }),
    description: z.string().optional(),
    default: z.string().optional(),
  })).optional(),
});

export type AgentEnvironmentConfig = z.infer<typeof AgentEnvironmentConfigSchema>;

/** LLM settings for configuration-based agents (TypeScript agents bring their own) */
export const AgentLLMConfigSchema = z.object({
  provider: z.enum(["anthropic", "openai", "google"], {
    message: "Provider must be 'anthropic', 'openai', or 'google'",
  }).optional(),
  model: z.string().optional(),
  temperature: z.number().min(0, {
    message: "Temperature must be at least 0",
  }).max(2, {
    message: "Temperature must be at most 2",
  }).optional(),
  max_tokens: z.number().positive({
    message: "Max tokens must be a positive number",
  }).optional(),
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

/**
 * Stream events that agents can emit back to Atlas
 *
 * Maps from any LLM library's streaming format to Atlas events.
 * Used by agent handlers to provide real-time feedback.
 */
export const StreamEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("text"),
    content: z.string(),
  }),
  z.object({
    type: z.literal("tool-call"),
    toolName: z.string(),
    args: z.unknown(),
  }),
  z.object({
    type: z.literal("tool-result"),
    toolName: z.string(),
    result: z.unknown(),
  }),
  z.object({
    type: z.literal("thinking"),
    content: z.string(),
  }),
  z.object({
    type: z.literal("error"),
    error: z.union([z.instanceof(Error), z.string()]),
  }),
  z.object({
    type: z.literal("finish"),
    reason: z.string().optional(),
  }),
  z.object({
    type: z.literal("usage"),
    tokens: z.object({
      input: z.number().optional(),
      cachedInput: z.number().optional(),
      output: z.number().optional(),
      total: z.number().optional(),
    }),
  }),
  z.object({
    type: z.literal("progress"),
    message: z.string(),
    percentage: z.number().optional(),
  }),
  z.object({
    type: z.literal("custom"),
    eventType: z.string(),
    data: z.unknown(),
  }),
]);

export type StreamEvent = z.infer<typeof StreamEventSchema>;

/** Stream emitter passed to agent handlers */
export interface StreamEmitter {
  emit: (event: StreamEvent) => void;
  end: () => void | Promise<void>;
  error: (error: Error) => void;
}

/** Atlas session data from request headers */
export const AgentSessionDataSchema = z.object({
  sessionId: z.string(),
  workspaceId: z.string(),
  userId: z.string().optional(),
});

export type AgentSessionData = z.infer<typeof AgentSessionDataSchema>;

/**
 * Context passed to agent handlers
 *
 * Contains everything agents need: tools, environment, streaming, logging.
 * Built by AtlasAgentsMCPServer before calling agent.execute().
 * Memory context is handled transparently by enriching the prompt.
 */
export interface AgentContext {
  /** All available tools from all servers (unified access) */
  tools: Record<string, AtlasTool>;

  /** Session info (workspace, user, etc.) */
  session: AgentSessionData;

  /** Environment variables validated at execution time */
  env: Record<string, string>;

  /** Stream events back to Atlas - always provided */
  stream: StreamEmitter;

  /** Logger instance with session context pre-configured */
  logger: Logger;
}

/**
 * Agent handler function - receives natural language prompts
 *
 * This is where agents interpret requests and decide what to do.
 * No action routing or structured inputs - just natural language.
 */
export type AgentHandler = (
  prompt: string,
  context: AgentContext,
) => Promise<unknown>;

/**
 * Config for createAgent() function
 *
 * TypeScript interface because handler functions can't be validated with Zod.
 * Use CreateAgentConfigValidationSchema for validating the non-function parts.
 */
export interface CreateAgentConfig extends AgentMetadata {
  /** Handler that processes all prompts for this agent */
  handler: AgentHandler;

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
export interface AtlasAgent {
  /** Agent metadata for registry */
  metadata: AgentMetadata;

  /** Execute agent with natural language prompt */
  execute(prompt: string, context: AgentContext): Promise<unknown>;

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
  lastExecution: z.object({
    prompt: z.string(),
    timestamp: z.number(),
    result: z.unknown().optional(),
  }).optional(),
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
  listAgents(filters?: {
    domains?: string[];
    tags?: string[];
  }): Promise<AgentMetadata[]>;

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
  agent: z.string().describe("Atlas agent ID from registry"),
  version: z.string().optional().describe("Agent version (defaults to latest)"),
  config: z.record(z.string(), z.unknown()).optional().describe(
    "Agent-specific configuration passed to the agent",
  ),
  environment: z.record(z.string(), z.string()).optional().describe(
    "Environment variables for the agent (supports ${VAR} interpolation)",
  ),
});

export type AtlasAgentConfig = z.infer<typeof AtlasAgentConfigSchema>;
