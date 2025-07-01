/**
 * Configuration schemas for Atlas using Zod v4
 */

import { z } from "zod/v4";

// MCP (Model Context Protocol) schemas
export const MCPTransportConfigSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("sse"),
    url: z.url(),
  }).strict(),
  z.object({
    type: z.literal("stdio"),
    command: z.string(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
  }).strict(),
]);

export const MCPAuthConfigSchema = z.object({
  type: z.enum(["bearer", "api_key"]),
  token_env: z.string().optional(),
  header: z.string().optional(),
});

export const MCPToolsConfigSchema = z.object({
  allowed: z.array(z.string()).optional(),
  denied: z.array(z.string()).optional(),
});

// Infer MCP types
export type MCPTransportConfig = z.infer<typeof MCPTransportConfigSchema>;
export type MCPAuthConfig = z.infer<typeof MCPAuthConfigSchema>;
export type MCPToolsConfig = z.infer<typeof MCPToolsConfigSchema>;

// Agent type schema
export const AgentTypeSchema = z.enum(["tempest", "llm", "remote"]);

// Environment variable configuration schema
export const EnvironmentVariableSchema = z.union([
  z.string(), // Direct value
  z.object({
    value: z.string().optional(),
    from_env: z.string().optional(),
    from_env_file: z.string().optional(),
    key: z.string().optional(), // For from_env_file
    from_file: z.string().optional(),
    default: z.string().optional(),
    required: z.boolean().default(false),
  }),
]);

// Scope configuration for federation
export const ScopeSchema = z.union([
  z.string(), // Reference to scope_sets
  z.array(z.string()), // Inline scope list
]);

// Federation sharing configuration
export const FederationSharingSchema = z.object({
  workspaces: z.union([z.string(), z.array(z.string())]).optional(),
  scopes: ScopeSchema.optional(),
  grants: z.array(z.object({
    workspace: z.string(),
    scopes: ScopeSchema,
  })).optional(),
});

// Federation configuration schema
export const FederationConfigSchema = z.object({
  sharing: z.record(z.string(), FederationSharingSchema).optional(),
  scope_sets: z.record(z.string(), z.array(z.string())).optional(),
});

// MCP tool name validation - dots are illegal in MCP tool names
const MCPToolNameSchema = z.string().regex(
  /^[a-zA-Z][a-zA-Z0-9_-]*$/,
  "MCP tool names must start with a letter and contain only letters, numbers, underscores, and hyphens (no dots)",
);

// MCP capability pattern validation - support wildcards but no dots in base names
const MCPCapabilityPatternSchema = z.string().regex(
  /^[a-zA-Z][a-zA-Z0-9_]*(\*)?$/,
  "MCP capability patterns must start with a letter, contain only letters, numbers, underscores, and optional trailing wildcard (*)",
);

// MCP job pattern validation - support wildcards and hyphens for job names
const MCPJobPatternSchema = z.string().regex(
  /^[a-zA-Z][a-zA-Z0-9_-]*(\*)?$/,
  "MCP job patterns must start with a letter, contain only letters, numbers, underscores, hyphens, and optional trailing wildcard (*)",
);

// MCP server configuration schema with environment variables
export const MCPServerConfigSchema = z.object({
  transport: MCPTransportConfigSchema,
  auth: MCPAuthConfigSchema.optional(),
  tools: MCPToolsConfigSchema.optional(),
  timeout_ms: z.number().positive().default(30000),
  env: z.record(z.string(), EnvironmentVariableSchema).optional(),
});

// Server configuration schema
export const ServerConfigSchema = z.object({
  mcp: z.object({
    enabled: z.boolean().default(false),
    transport: MCPTransportConfigSchema.optional(),
    discoverable: z.object({
      capabilities: z.array(MCPCapabilityPatternSchema).optional(),
      jobs: z.array(MCPJobPatternSchema).optional(),
    }).optional(),
    auth: z.object({
      required: z.boolean().default(false),
      providers: z.array(z.string()).optional(),
    }).optional(),
    rate_limits: z.object({
      requests_per_hour: z.number().positive().optional(),
      concurrent_sessions: z.number().positive().optional(),
    }).optional(),
  }).optional(),
  acp: z.object({
    enabled: z.boolean().default(false),
    discoverable_agents: z.array(z.string()).optional(),
  }).optional(),
  rest: z.object({
    enabled: z.boolean().default(false),
    prefix: z.string().default("/api/v1"),
    swagger: z.boolean().default(false),
  }).optional(),
});

// MCP client tools configuration
export const MCPToolsConfigSchema2 = z.object({
  client_config: z.object({
    timeout: z.number().positive().default(30000),
    retry_policy: z.object({
      max_attempts: z.number().positive().default(3),
    }).optional(),
    connection_pool: z.object({
      max_connections: z.number().positive().default(10),
    }).optional(),
  }).optional(),
  servers: z.record(z.string(), MCPServerConfigSchema).optional(),
  policies: z.object({
    type: z.enum(["allowlist", "denylist"]).default("allowlist"),
    allowed: z.array(z.union([
      z.string(),
      z.object({
        id: z.string(),
        restrictions: z.record(z.string(), z.any()).optional(),
      }),
    ])).optional(),
    denied: z.array(z.string()).optional(),
  }).optional(),
});

// Tools configuration schema
export const ToolsConfigSchema = z.object({
  mcp: MCPToolsConfigSchema2.optional(),
});

// Workspace identification schema
export const WorkspaceIdentitySchema = z.object({
  id: z.string().optional(), // ID is generated automatically, not required in config
  name: z.string(),
  description: z.string().optional(),
});

export const AuthConfigSchema = z
  .object({
    type: z.enum(["bearer", "api_key", "basic", "none"]),
    token_env: z.string().optional(),
    token: z.string().optional(),
    api_key_env: z.string().optional(),
    api_key: z.string().optional(),
    header: z.string().default("Authorization"),
  })
  .catchall(z.any());

export const SchemaObjectSchema = z
  .object({
    type: z.string(),
    properties: z.record(z.string(), z.any()).optional(),
    required: z.array(z.string()).optional(),
    items: z.any().optional(),
    minimum: z.number().optional(),
    maximum: z.number().optional(),
    enum: z.array(z.string()).optional(),
    description: z.string().optional(),
  })
  .catchall(z.any());

// ACP-specific configuration schema
export const ACPConfigSchema = z.object({
  agent_name: z.string().min(1).max(63).regex(
    /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/,
    "Agent name must be lowercase alphanumeric with hyphens",
  ),
  default_mode: z.enum(["sync", "async", "stream"]).default("sync"),
  timeout_ms: z.number().positive().default(30000),
  max_retries: z.number().min(0).default(3),
  health_check_interval: z.number().positive().default(60000),
});

// MCP-specific configuration schema (for remote agents)
export const MCPConfigSchema = z.object({
  timeout_ms: z.number().positive().default(30000),
  allowed_tools: z.array(z.string()).optional(),
  denied_tools: z.array(z.string()).optional(),
});

// Legacy MCP server configuration schema (keeping for backward compatibility)
export const WorkspaceMCPServerConfigSchema = z.object({
  id: z.string().optional(), // ID is derived from key, but can be overridden
  transport: MCPTransportConfigSchema,
  auth: MCPAuthConfigSchema.optional(),
  tools: MCPToolsConfigSchema.optional(),
  timeout_ms: z.number().positive().default(30000),
  env: z.record(z.string(), EnvironmentVariableSchema).optional(),
});

// Validation configuration schema
export const ValidationConfigSchema = z.object({
  test_execution: z.boolean().default(true),
  timeout_ms: z.number().positive().default(10000),
});

// Circuit breaker configuration schema
export const CircuitBreakerConfigSchema = z.object({
  failure_threshold: z.number().positive().default(5),
  timeout_ms: z.number().positive().default(60000),
  half_open_max_calls: z.number().positive().default(3),
});

// Monitoring configuration schema
export const MonitoringConfigSchema = z.object({
  enabled: z.boolean().default(true),
  circuit_breaker: CircuitBreakerConfigSchema.optional(),
});

export const WorkspaceAgentConfigSchema = z
  .object({
    type: AgentTypeSchema,
    provider: z.enum(["anthropic", "openai", "google"]).optional(),
    model: z.string().optional(),
    purpose: z.string(),
    // Built-in workspace tools (ambient capabilities)
    tools: z.union([
      z.array(z.string()), // Simple array format: ["workspace.jobs.trigger", "workspace.memory.recall"]
      z.object({
        mcp: z.array(z.string()).optional(), // MCP servers: ["server-id"] -> tools.mcp.servers.server-id
        workspace: z.array(z.string()).optional(), // Workspace capabilities
      }),
    ]).optional(),
    default_tools: z.array(z.string()).optional(), // Default tools for this agent type
    prompts: z.record(z.string(), z.string()).optional(),
    temperature: z.number().min(0).max(2).optional(),
    max_tokens: z.number().positive().optional(),
    // MCP integration (only for LLM agents) - DEPRECATED, use tools.mcp instead
    mcp_servers: z.array(z.string()).optional(), // Legacy: References to MCP servers (LLM agents only)
    max_steps: z.number().positive().optional(), // For multi-step tool calling (LLM agents only)
    tool_choice: z
      .union([
        z.literal("auto"),
        z.literal("required"),
        z.literal("none"),
        z.object({
          type: z.literal("tool"),
          toolName: z.string(),
        }),
      ])
      .optional(), // Tool choice control
    // Tempest agent specific
    agent: z.string().optional(),
    version: z.string().optional(),
    config: z.record(z.string(), z.any()).optional(),
    // Remote agent specific
    protocol: z.enum(["acp", "mcp"]).optional(),
    endpoint: z.url().optional(),
    auth: AuthConfigSchema.optional(),
    timeout: z.number().positive().optional(),

    // Protocol-specific configurations
    acp: ACPConfigSchema.optional(),
    mcp: MCPConfigSchema.optional(),

    // Schema validation
    schema: z
      .object({
        validate_input: z.boolean().default(false),
        validate_output: z.boolean().default(false),
        input: SchemaObjectSchema.optional(),
        output: SchemaObjectSchema.optional(),
      })
      .optional(),

    // Validation settings
    validation: ValidationConfigSchema.optional(),

    // Monitoring configuration
    monitoring: MonitoringConfigSchema.optional(),
  })
  .superRefine((value, ctx) => {
    // Type-specific validation with detailed error messages
    if (value.type === "tempest") {
      if (!value.agent) {
        ctx.addIssue({
          code: "custom",
          message: "Tempest agents require 'agent' field",
          path: ["agent"],
          input: value,
        });
      }
      if (!value.version) {
        ctx.addIssue({
          code: "custom",
          message: "Tempest agents require 'version' field",
          path: ["version"],
          input: value,
        });
      }
    } else if (value.type === "llm") {
      if (!value.model) {
        ctx.addIssue({
          code: "custom",
          message: "LLM agents require 'model' field",
          path: ["model"],
          input: value,
        });
      }

      // Validate provider and model combination
      const provider = value.provider || "anthropic";
      const model = value.model;

      const supportedModels = {
        anthropic: [
          "claude-3-5-sonnet-20241022",
          "claude-3-5-haiku-20241022",
          "claude-3-haiku-20240307",
          "claude-3-sonnet-20240229",
          "claude-3-opus-20240229",
        ],
        openai: [
          "gpt-4o",
          "gpt-4o-mini",
          "gpt-4-turbo",
          "gpt-4",
          "gpt-3.5-turbo",
        ],
        google: [
          "gemini-1.5-pro",
          "gemini-1.5-flash",
          "gemini-pro",
        ],
      };

      if (model && !supportedModels[provider as keyof typeof supportedModels]?.includes(model)) {
        ctx.addIssue({
          code: "custom",
          message:
            `Model '${model}' is not supported by provider '${provider}'. Supported models: ${
              supportedModels[provider as keyof typeof supportedModels]?.join(", ") || "none"
            }`,
          path: ["model"],
          input: value,
        });
      }
    } else if (value.type === "remote") {
      if (!value.endpoint) {
        ctx.addIssue({
          code: "custom",
          message: "Remote agents require 'endpoint' field",
          path: ["endpoint"],
          input: value,
        });
      }

      if (!value.protocol) {
        ctx.addIssue({
          code: "custom",
          message: "Remote agents require 'protocol' field (acp, or mcp)",
          path: ["protocol"],
          input: value,
        });
      }

      // Protocol-specific validation
      if (value.protocol === "acp") {
        if (!value.acp?.agent_name) {
          ctx.addIssue({
            code: "custom",
            message: "ACP remote agents require 'acp.agent_name' field",
            path: ["acp", "agent_name"],
            input: value,
          });
        }
      } else if (value.protocol === "mcp") {
        // MCP doesn't require specific fields beyond endpoint
        // Optional tools filtering can be configured via mcp.allowed_tools/denied_tools
      }

      // Authentication validation
      if (value.auth) {
        const authType = value.auth.type;
        if (authType === "bearer" && !value.auth.token_env && !value.auth.token) {
          ctx.addIssue({
            code: "custom",
            message: "Bearer auth requires either 'token_env' or 'token' field",
            path: ["auth"],
            input: value,
          });
        }
        if (authType === "api_key" && !value.auth.api_key_env && !value.auth.token_env) {
          ctx.addIssue({
            code: "custom",
            message: "API key auth requires either 'api_key_env' or 'token_env' field",
            path: ["auth"],
            input: value,
          });
        }
      }
    }
  });

// Job execution strategy schema
export const JobExecutionSchema = z.object({
  strategy: z.enum(["sequential", "parallel"]),
  agents: z.array(
    z.union([
      z.string(),
      z.object({
        id: z.string(),
        task: z.string().optional(),
        input_source: z.enum(["signal", "previous", "combined", "filesystem_context"]).optional(),
        dependencies: z.array(z.string()).optional(),
        // Tools granted to this agent for this job
        tools: z.array(z.string()).optional(),
      }),
    ]),
  ),
});

// Trigger specification schema for job-owns-relationship
export const TriggerSpecificationSchema = z.object({
  signal: z.string(), // Signal name this job listens to
  condition: z.union([z.string(), z.record(z.string(), z.any())]).optional(), // Optional condition for triggering (string or JSONLogic object)
});

// Job specification schema for top-level jobs section
export const JobSpecificationSchema = z.object({
  name: MCPToolNameSchema.optional(), // Job names become MCP tools, so validate MCP compliance. Optional - uses key if not provided
  description: z.string().optional(),
  task_template: z.string().optional(), // Optional task template for clearer agent instructions
  triggers: z.array(TriggerSpecificationSchema).optional(), // NEW: Jobs define their signal triggers
  session_prompts: z.object({
    planning: z.string().optional(),
    evaluation: z.string().optional(),
  }).optional(),
  execution: JobExecutionSchema.extend({
    context: z.object({
      filesystem: z.object({
        patterns: z.array(z.string()),
        base_path: z.string().optional(),
        max_file_size: z.number().optional(),
        include_content: z.boolean().optional(),
      }).optional(),
    }).catchall(z.any()).optional(),
  }),
  success_criteria: z.record(z.string(), z.any()).optional(),
  error_handling: z.object({
    max_retries: z.number().optional(),
    retry_delay_seconds: z.number().optional(),
    timeout_seconds: z.number().optional(),
  }).optional(),
  resources: z.object({
    estimated_duration_seconds: z.number().optional(),
    max_memory_mb: z.number().optional(),
    required_capabilities: z.array(z.string()).optional(),
  }).optional(),
});

export const WorkspaceSignalConfigSchema = z.object({
  description: z.string(),
  provider: z.string(),
  schema: SchemaObjectSchema.optional(),
  // REMOVED: jobs field - jobs now define their own triggers
  // Provider-specific configuration fields
  source: z.string().optional(),
  endpoint: z.string().optional(),
  timeout_ms: z.number().positive().optional(),
  retry_config: z.object({
    max_retries: z.number().min(0).optional(),
    retry_delay_ms: z.number().positive().optional(),
  }).optional(),
  // HTTP provider specific
  path: z.string().optional(),
  method: z.enum(["GET", "POST", "PUT", "DELETE", "PATCH"]).optional(),
  // CLI provider specific
  command: z.string().optional(),
  // Timer/Cron provider specific
  schedule: z.string().optional(), // Cron expression for timer/cron providers
  timezone: z.string().optional(), // IANA timezone for cron-scheduler provider
}).catchall(z.any()); // Allow additional provider-specific fields

export const WorkspaceConfigSchema = z.object({
  version: z.string(),

  // Workspace identity (ID is generated automatically, not in config)
  workspace: WorkspaceIdentitySchema.extend({
    name: z.string().min(1, "Workspace name cannot be empty"),
  }), // ID is optional - generated automatically if not provided

  // Server configuration (how this workspace exposes itself)
  server: ServerConfigSchema.optional(),

  // Tools configuration (MCP client config and servers)
  tools: ToolsConfigSchema.optional(),

  // Workspace capabilities (jobs, signals, agents)
  jobs: z.record(MCPToolNameSchema, JobSpecificationSchema).optional(), // Job keys become MCP tools
  signals: z.record(z.string(), WorkspaceSignalConfigSchema).optional(),
  agents: z.record(z.string(), WorkspaceAgentConfigSchema).optional(),

  // Legacy MCP servers configuration (keeping for backward compatibility)
  mcp_servers: z.record(z.string(), WorkspaceMCPServerConfigSchema).optional(),
});

export const SupervisorConfigSchema = z.object({
  model: z.string(),
  memory: z.string().optional(),
  supervision: z.object({
    level: z.enum(["minimal", "standard", "detailed", "paranoid"]).default("standard"),
    cache_enabled: z.boolean().default(true),
    cache_adapter: z.enum(["memory", "redis", "file"]).default("memory"),
    cache_ttl_hours: z.number().positive().default(1),
    parallel_llm_calls: z.boolean().default(true),
    timeouts: z.object({
      analysis_ms: z.number().positive().default(10000),
      validation_ms: z.number().positive().default(8000),
      execution_ms: z.number().positive().optional(),
    }).optional(),
  }).optional(),
  prompts: z
    .object({
      system: z.string(),
    })
    .catchall(z.string()),
});

// Supervisor defaults schema (for supervisor-defaults.yml/ts)
export const SupervisorDefaultsSchema = z.object({
  version: z.string(),
  supervisors: z.object({
    workspace: SupervisorConfigSchema,
    session: SupervisorConfigSchema,
    agent: SupervisorConfigSchema,
  }),
});

// New unified AtlasConfigSchema - atlas.yml IS a workspace with platform capabilities
export const AtlasConfigSchema = z.object({
  version: z.string(),

  // Workspace identity (atlas.yml IS a workspace)
  workspace: WorkspaceIdentitySchema.extend({
    id: z.string().default("atlas-platform"),
    name: z.string().default("Atlas Platform"),
  }),

  // Server configuration (how this platform workspace exposes itself)
  server: ServerConfigSchema.optional(),

  // Tools configuration (MCP client config, servers, and policies for child workspaces)
  tools: ToolsConfigSchema.optional(),

  // Federation configuration (cross-workspace sharing and policies)
  federation: FederationConfigSchema.optional(),

  // Platform capabilities as jobs, signals, and agents (same as workspace.yml)
  jobs: z.record(z.string(), JobSpecificationSchema).optional(),
  signals: z.record(z.string(), WorkspaceSignalConfigSchema).optional(),
  agents: z.record(z.string(), WorkspaceAgentConfigSchema).optional(),

  // Memory configuration (required for supervisors)
  memory: z.object({
    default: z.object({
      enabled: z.boolean(),
      storage: z.string(),
      cognitive_loop: z.boolean(),
      retention: z.object({
        max_age_days: z.number(),
        max_entries: z.number().optional(),
        cleanup_interval_hours: z.number(),
      }),
    }),
    streaming: z.object({
      enabled: z.boolean(),
      queue_max_size: z.number(),
      batch_size: z.number(),
      flush_interval_ms: z.number(),
      background_processing: z.boolean(),
      persistence_enabled: z.boolean(),
      error_retry_attempts: z.number(),
      priority_processing: z.boolean(),
      dual_write_enabled: z.boolean(),
      legacy_batch_enabled: z.boolean(),
      stream_everything: z.boolean(),
      performance_tracking: z.boolean(),
    }).optional(),
    agent: z.object({
      enabled: z.boolean(),
      scope: z.enum(["agent", "session", "workspace"]),
      include_in_context: z.boolean(),
      context_limits: z.object({
        relevant_memories: z.number(),
        past_successes: z.number(),
        past_failures: z.number(),
      }),
      memory_types: z.record(
        z.string(),
        z.object({
          enabled: z.boolean(),
          max_age_hours: z.number().optional(),
          max_age_days: z.number().optional(),
          max_entries: z.number().optional(),
        }),
      ),
    }),
    session: z.object({
      enabled: z.boolean(),
      scope: z.enum(["agent", "session", "workspace"]),
      include_in_context: z.boolean(),
      context_limits: z.object({
        relevant_memories: z.number(),
        past_successes: z.number(),
        past_failures: z.number(),
      }),
      memory_types: z.record(
        z.string(),
        z.object({
          enabled: z.boolean(),
          max_age_hours: z.number().optional(),
          max_age_days: z.number().optional(),
          max_entries: z.number().optional(),
        }),
      ),
    }),
    workspace: z.object({
      enabled: z.boolean(),
      scope: z.enum(["agent", "session", "workspace"]),
      include_in_context: z.boolean(),
      context_limits: z.object({
        relevant_memories: z.number(),
        past_successes: z.number(),
        past_failures: z.number(),
      }),
      memory_types: z.record(
        z.string(),
        z.object({
          enabled: z.boolean(),
          max_age_hours: z.number().optional(),
          max_age_days: z.number().optional(),
          max_entries: z.number().optional(),
        }),
      ),
    }),
  }).optional(),

  // A Priori Planning Configuration
  planning: z.object({
    execution: z.object({
      precomputation: z.enum(["aggressive", "moderate", "minimal", "disabled"]),
      cache_enabled: z.boolean(),
      cache_ttl_hours: z.number(),
      invalidate_on_job_change: z.boolean(),
      strategy_selection: z.object({
        simple_jobs: z.string(),
        complex_jobs: z.string(),
        optimization_jobs: z.string(),
        planning_jobs: z.string(),
      }),
      strategy_thresholds: z.object({
        complexity: z.number(),
        uncertainty: z.number(),
        optimization: z.number(),
      }),
    }),
    validation: z.object({
      precomputation: z.enum(["aggressive", "moderate", "minimal", "disabled"]),
      functional_validators: z.boolean(),
      smoke_tests: z.boolean(),
      content_safety: z.boolean(),
      llm_threshold: z.number(),
      llm_fallback: z.boolean(),
      cache_enabled: z.boolean(),
      cache_ttl_hours: z.number(),
      fail_fast: z.boolean(),
      external_services: z.object({
        openai_moderation: z.boolean(),
        perspective_api: z.boolean(),
        deepeval_service: z.string().nullable(),
      }),
    }),
  }).optional(),

  // Supervisor configuration (platform-level defaults)
  supervisors: z.object({
    workspace: SupervisorConfigSchema,
    session: SupervisorConfigSchema,
    agent: SupervisorConfigSchema,
  }).optional(),

  // Runtime configuration (platform-specific settings)
  runtime: z
    .object({
      server: z
        .object({
          port: z.number().int().min(1).max(65535),
          host: z.string(),
        })
        .optional(),
      logging: z
        .object({
          level: z.enum(["debug", "info", "warn", "error"]),
          format: z.enum(["json", "pretty"]),
        })
        .optional(),
      persistence: z
        .object({
          type: z.enum(["local", "memory", "s3", "gcs"]),
          path: z.string(),
        })
        .optional(),
      security: z
        .object({
          cors: z.string(),
        })
        .optional(),
    })
    .optional(),
});

// Inferred types from Zod schemas
export type AtlasConfig = z.infer<typeof AtlasConfigSchema>;
export type WorkspaceConfig = z.infer<typeof WorkspaceConfigSchema>;
export type WorkspaceAgentConfig = z.infer<typeof WorkspaceAgentConfigSchema>;
export type WorkspaceSignalConfig = z.infer<typeof WorkspaceSignalConfigSchema>;
export type WorkspaceMCPServerConfig = z.infer<typeof WorkspaceMCPServerConfigSchema>;
export type TriggerSpecification = z.infer<typeof TriggerSpecificationSchema>;
export type JobSpecification = z.infer<typeof JobSpecificationSchema>;
export type SupervisorDefaults = z.infer<typeof SupervisorDefaultsSchema>;

// New architectural foundation types
export type EnvironmentVariable = z.infer<typeof EnvironmentVariableSchema>;
export type FederationConfig = z.infer<typeof FederationConfigSchema>;
export type FederationSharing = z.infer<typeof FederationSharingSchema>;
export type ServerConfig = z.infer<typeof ServerConfigSchema>;
export type ToolsConfig = z.infer<typeof ToolsConfigSchema>;
export type MCPServerConfig = z.infer<typeof MCPServerConfigSchema>;
export type WorkspaceIdentity = z.infer<typeof WorkspaceIdentitySchema>;

// Merged configuration that combines both
export interface MergedConfig {
  atlas: AtlasConfig;
  workspace: WorkspaceConfig;
  jobs: Record<string, JobSpecification>;
  supervisorDefaults: SupervisorDefaults;
}

// Helper method to extract AgentSupervisor config from AtlasConfig
export function getAgentSupervisorConfig(atlasConfig: AtlasConfig): {
  model: string;
  prompts: Record<string, string>;
} {
  return {
    model: atlasConfig.supervisors.agent.model,
    prompts: atlasConfig.supervisors.agent.prompts,
  };
}
