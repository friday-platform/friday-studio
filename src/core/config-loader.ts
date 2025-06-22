/**
 * Configuration loader for Atlas that merges atlas.yml and workspace.yml
 */

import { join } from "@std/path";
import { parse as parseYaml } from "@std/yaml";
import { z } from "zod/v4";
import {
  MCPAuthConfigSchema,
  MCPToolsConfigSchema,
  MCPTransportConfigSchema,
} from "./agents/mcp/mcp-manager.ts";
import type {
  AgentConfig,
  JobSpecification,
  LLMAgentConfig,
  RemoteAgentConfig,
  TempestAgentConfig,
} from "./session-supervisor.ts";

// Custom error class for configuration validation
export class ConfigValidationError extends Error {
  constructor(
    message: string,
    public file: string,
    public field?: string,
    public value?: unknown,
  ) {
    super(message);
    this.name = "ConfigValidationError";
  }
}

// Zod schemas for validation
const AgentTypeSchema = z.enum(["tempest", "llm", "remote"]);

const AuthConfigSchema = z
  .object({
    type: z.enum(["bearer", "api_key", "basic", "none"]),
    token_env: z.string().optional(),
    token: z.string().optional(),
    api_key_env: z.string().optional(),
    api_key: z.string().optional(),
    header: z.string().default("Authorization"),
  })
  .catchall(z.any());

const SchemaObjectSchema = z
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
const ACPConfigSchema = z.object({
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
const MCPConfigSchema = z.object({
  timeout_ms: z.number().positive().default(30000),
  allowed_tools: z.array(z.string()).optional(),
  denied_tools: z.array(z.string()).optional(),
});

// Comprehensive MCP server configuration schema for workspace-level MCP servers
const WorkspaceMCPServerConfigSchema = z.object({
  id: z.string().optional(), // ID is derived from key, but can be overridden
  transport: MCPTransportConfigSchema,
  auth: MCPAuthConfigSchema.optional(),
  tools: MCPToolsConfigSchema.optional(),
  timeout_ms: z.number().positive().default(30000),
});

// Validation configuration schema
const ValidationConfigSchema = z.object({
  test_execution: z.boolean().default(true),
  timeout_ms: z.number().positive().default(10000),
});

// Circuit breaker configuration schema
const CircuitBreakerConfigSchema = z.object({
  failure_threshold: z.number().positive().default(5),
  timeout_ms: z.number().positive().default(60000),
  half_open_max_calls: z.number().positive().default(3),
});

// Monitoring configuration schema
const MonitoringConfigSchema = z.object({
  enabled: z.boolean().default(true),
  circuit_breaker: CircuitBreakerConfigSchema.optional(),
});

const WorkspaceAgentConfigSchema = z
  .object({
    type: AgentTypeSchema,
    provider: z.enum(["anthropic", "openai", "google"]).optional(),
    model: z.string().optional(),
    purpose: z.string(),
    tools: z.array(z.string()).optional(),
    prompts: z.record(z.string(), z.string()).optional(),
    temperature: z.number().min(0).max(2).optional(),
    max_tokens: z.number().positive().optional(),
    // MCP integration (only for LLM agents)
    mcp_servers: z.array(z.string()).optional(), // References to MCP servers (LLM agents only)
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
    endpoint: z.string().url().optional(),
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
const JobExecutionSchema = z.object({
  strategy: z.enum(["sequential", "parallel"]),
  agents: z.array(
    z.union([
      z.string(),
      z.object({
        id: z.string(),
        task: z.string().optional(),
        inputSource: z.string().optional(),
        dependencies: z.array(z.string()).optional(),
      }),
    ]),
  ),
});

// Trigger specification schema for job-owns-relationship
const TriggerSpecificationSchema = z.object({
  signal: z.string(), // Signal name this job listens to
  condition: z.union([z.string(), z.record(z.string(), z.any())]).optional(), // Optional condition for triggering (string or JSONLogic object)
});

// Job specification schema for top-level jobs section
const JobSpecificationSchema = z.object({
  name: z.string(),
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

const WorkspaceSignalConfigSchema = z.object({
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
}).catchall(z.any()); // Allow additional provider-specific fields

export const NewWorkspaceConfigSchema = z.object({
  version: z.string(),
  workspace: z.object({
    id: z.string().uuid("Workspace ID must be a valid UUID"),
    name: z.string().min(1, "Workspace name cannot be empty"),
    description: z.string(),
  }),
  mcp_servers: z.record(z.string(), WorkspaceMCPServerConfigSchema).optional(), // MCP servers configuration
  agents: z.record(z.string(), WorkspaceAgentConfigSchema),
  jobs: z.record(z.string(), JobSpecificationSchema).optional(), // Top-level jobs section
  signals: z.record(z.string(), WorkspaceSignalConfigSchema),
});

const SupervisorConfigSchema = z.object({
  model: z.string(),
  prompts: z
    .object({
      system: z.string(),
    })
    .catchall(z.string()),
});

const AtlasConfigSchema = z.object({
  version: z.string(),
  platform: z.object({
    name: z.string(),
    version: z.string(),
  }),
  agents: z.record(z.string(), WorkspaceAgentConfigSchema),
  supervisors: z.object({
    workspace: SupervisorConfigSchema,
    session: SupervisorConfigSchema,
    agent: SupervisorConfigSchema,
  }),
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
export type NewWorkspaceConfig = z.infer<typeof NewWorkspaceConfigSchema>;
export type WorkspaceAgentConfig = z.infer<typeof WorkspaceAgentConfigSchema>;
export type WorkspaceSignalConfig = z.infer<typeof WorkspaceSignalConfigSchema>;
export type WorkspaceMCPServerConfig = z.infer<typeof WorkspaceMCPServerConfigSchema>;
export type TriggerSpecification = z.infer<typeof TriggerSpecificationSchema>;

// Merged configuration that combines both
export interface MergedConfig {
  atlas: AtlasConfig;
  workspace: NewWorkspaceConfig;
  jobs: Record<string, JobSpecification>;
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

export class ConfigLoader {
  private atlasConfigPath: string;
  private workspaceConfigPath: string;
  private workspaceDir: string;

  constructor(workspaceDir: string = ".") {
    this.workspaceDir = workspaceDir;

    // Check for workspace-local atlas.yml first, then fall back to git root
    const workspaceAtlasPath = join(workspaceDir, "atlas.yml");

    try {
      // Try to access workspace-local atlas.yml
      Deno.statSync(workspaceAtlasPath);
      this.atlasConfigPath = workspaceAtlasPath;
      console.log(`Using workspace-local atlas.yml: ${workspaceAtlasPath}`);
    } catch {
      // Fall back to git root atlas.yml
      try {
        const gitRoot = new Deno.Command("git", {
          args: ["rev-parse", "--show-toplevel"],
          stdout: "piped",
        }).outputSync();
        const rootDir = new TextDecoder().decode(gitRoot.stdout).trim();
        this.atlasConfigPath = join(rootDir, "atlas.yml");
        console.log(`Using git root atlas.yml: ${this.atlasConfigPath}`);
      } catch {
        // If we can't find git root, use workspace directory as fallback
        this.atlasConfigPath = workspaceAtlasPath;
        console.log(
          `Git root not found, will use/create workspace atlas.yml: ${workspaceAtlasPath}`,
        );
      }
    }

    this.workspaceConfigPath = join(workspaceDir, "workspace.yml");
  }

  async load(): Promise<MergedConfig> {
    // Load atlas.yml - platform configuration
    const atlasConfig = await this.loadAtlasConfig();

    // Load workspace.yml - user configuration
    const workspaceConfig = await this.loadWorkspaceConfig();

    // Load all job specifications
    const jobs = this.loadJobSpecs(workspaceConfig);

    // Validate merged configuration
    this.validateConfig(atlasConfig, workspaceConfig, jobs);

    return {
      atlas: atlasConfig,
      workspace: workspaceConfig,
      jobs,
    };
  }

  private async loadAtlasConfig(): Promise<AtlasConfig> {
    try {
      const content = await Deno.readTextFile(this.atlasConfigPath);
      const rawConfig = parseYaml(content);

      // Validate with Zod
      const config = AtlasConfigSchema.parse(rawConfig);
      return config;
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        // Create default atlas.yml if it doesn't exist
        console.warn(
          "[ConfigLoader] atlas.yml not found, using default configuration",
        );
        return this.createDefaultAtlasConfig();
      }
      if (error instanceof z.ZodError) {
        throw new ConfigValidationError(
          this.formatZodError(error, "atlas.yml"),
          "atlas.yml",
        );
      }
      throw new ConfigValidationError(
        `Failed to load atlas.yml: ${error instanceof Error ? error.message : String(error)}`,
        "atlas.yml",
      );
    }
  }

  private async loadWorkspaceConfig(): Promise<NewWorkspaceConfig> {
    try {
      const content = await Deno.readTextFile(this.workspaceConfigPath);
      const rawConfig = parseYaml(content);

      // Validate with Zod
      const config = NewWorkspaceConfigSchema.parse(rawConfig);
      return config;
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        throw new ConfigValidationError(
          "workspace.yml not found - this file is required",
          "workspace.yml",
        );
      }
      if (error instanceof z.ZodError) {
        throw new ConfigValidationError(
          this.formatZodError(error, "workspace.yml"),
          "workspace.yml",
        );
      }
      throw new ConfigValidationError(
        `Failed to load workspace.yml: ${error instanceof Error ? error.message : String(error)}`,
        "workspace.yml",
      );
    }
  }

  private loadJobSpecs(
    workspaceConfig: NewWorkspaceConfig,
  ): Record<string, JobSpecification> {
    const jobs: Record<string, JobSpecification> = {};

    // Load jobs from top-level jobs section
    if (workspaceConfig.jobs) {
      for (const [jobName, jobSpec] of Object.entries(workspaceConfig.jobs)) {
        // Normalize string agents to JobAgentSpec objects
        const normalizedAgents = jobSpec.execution.agents.map((agent) => {
          if (typeof agent === "string") {
            return { id: agent };
          }
          return agent;
        });

        const normalizedJobSpec: JobSpecification = {
          name: jobName, // Use the key as the name
          description: jobSpec.description || `Top-level job: ${jobName}`,
          task_template: jobSpec.task_template, // Include task template if provided
          triggers: jobSpec.triggers, // Include triggers for signal-to-job mapping
          execution: {
            strategy: jobSpec.execution.strategy,
            agents: normalizedAgents,
            context: jobSpec.execution.context, // Include context
          },
          session_prompts: jobSpec.session_prompts, // Include session prompts
          success_criteria: jobSpec.success_criteria,
          error_handling: jobSpec.error_handling,
          resources: jobSpec.resources,
        };

        jobs[jobName] = normalizedJobSpec;
      }
    }

    // Load jobs from separate job files in jobs/ directory
    const jobsFromFiles = this.loadJobsFromFiles();
    Object.assign(jobs, jobsFromFiles);

    return jobs;
  }

  private loadJobsFromFiles(): Record<string, JobSpecification> {
    const jobs: Record<string, JobSpecification> = {};

    try {
      const jobsPath = `${this.workspaceDir}/jobs`;

      // Check if jobs directory exists
      const stat = Deno.statSync(jobsPath);
      if (!stat.isDirectory) {
        return jobs;
      }

      // Read all .yml and .yaml files in jobs directory
      for (const dirEntry of Deno.readDirSync(jobsPath)) {
        if (
          dirEntry.isFile && (dirEntry.name.endsWith(".yml") || dirEntry.name.endsWith(".yaml"))
        ) {
          try {
            const jobFilePath = `${jobsPath}/${dirEntry.name}`;
            const jobContent = Deno.readTextFileSync(jobFilePath);
            const jobSpec = parseYaml(jobContent) as JobSpecification;

            // Use filename (without extension) as job name if not specified
            const jobName = jobSpec.name || dirEntry.name.replace(/\.(yml|yaml)$/, "");

            // Normalize agents if needed
            if (jobSpec.execution?.agents) {
              jobSpec.execution.agents = jobSpec.execution.agents.map((agent) => {
                if (typeof agent === "string") {
                  return { id: agent };
                }
                return agent;
              });
            }

            jobs[jobName] = {
              ...jobSpec,
              name: jobName,
            };

            console.log(`Loaded job spec: ${jobName} from ${dirEntry.name}`);
          } catch (error) {
            console.error(`Failed to load job file ${dirEntry.name}: ${error}`);
          }
        }
      }
    } catch (error) {
      // Jobs directory doesn't exist or can't be read - that's fine
      console.log(`Jobs directory not found or accessible: ${error}`);
    }

    return jobs;
  }

  private validateConfig(
    atlasConfig: AtlasConfig,
    workspaceConfig: NewWorkspaceConfig,
    jobs: Record<string, JobSpecification>,
  ): void {
    // Validate MCP server references in agents
    for (const [agentId, agentConfig] of Object.entries(workspaceConfig.agents)) {
      if (agentConfig.mcp_servers && agentConfig.mcp_servers.length > 0) {
        // Ensure agent is LLM type if using MCP servers
        if (agentConfig.type !== "llm") {
          throw new ConfigValidationError(
            `Agent '${agentId}' has mcp_servers configured but is not an LLM agent. Only LLM agents support MCP servers.`,
            "workspace.yml",
            `agents.${agentId}.mcp_servers`,
            agentConfig.mcp_servers,
          );
        }

        // Validate each MCP server reference exists
        for (const mcpServerId of agentConfig.mcp_servers) {
          if (!workspaceConfig.mcp_servers?.[mcpServerId]) {
            throw new ConfigValidationError(
              `Agent '${agentId}' references MCP server '${mcpServerId}' which is not defined in mcp_servers section`,
              "workspace.yml",
              `agents.${agentId}.mcp_servers`,
              mcpServerId,
            );
          }
        }
      }
    }

    // Cross-validate job trigger references and agent availability
    for (const [jobName, jobSpec] of Object.entries(jobs)) {
      // Validate that agents referenced in job exist in workspace or atlas
      if (jobSpec.execution?.agents) {
        for (const agentRef of jobSpec.execution.agents) {
          const agentId = typeof agentRef === "string" ? agentRef : agentRef.id;
          if (
            !workspaceConfig.agents[agentId] &&
            !atlasConfig.agents[agentId]
          ) {
            throw new ConfigValidationError(
              `Job '${jobName}' references agent '${agentId}' which is not defined in workspace or atlas agents`,
              "workspace.yml",
              `jobs.${jobName}.execution.agents`,
              agentRef,
            );
          }
        }
      }

      // Validate that signals referenced in job triggers exist
      if ((jobSpec as any).triggers) {
        for (const trigger of (jobSpec as any).triggers) {
          const signalId = trigger.signal;
          if (!workspaceConfig.signals[signalId]) {
            throw new ConfigValidationError(
              `Job '${jobName}' references signal '${signalId}' which is not defined in workspace signals`,
              "workspace.yml",
              `jobs.${jobName}.triggers`,
              trigger,
            );
          }
        }
      }
    }

    // Validate signal-job mappings that were injected for compatibility
    for (
      const [signalId, signalConfig] of Object.entries(
        workspaceConfig.signals,
      )
    ) {
      if ((signalConfig as any).jobs) {
        for (const jobMapping of (signalConfig as any).jobs) {
          const jobName = jobMapping.job;
          if (!jobs[jobName]) {
            throw new ConfigValidationError(
              `Signal '${signalId}' references job '${jobName}' which was not found`,
              "workspace.yml",
              `signals.${signalId}.jobs`,
              jobMapping,
            );
          }
        }
      }
    }
  }

  private formatZodError(error: z.ZodError, filename: string): string {
    const issues = error.issues.map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "root";
      let message = `  • ${path}: ${issue.message}`;

      // Add received value for certain issue types
      if ("received" in issue && issue.received !== undefined) {
        message += ` (received: ${issue.received})`;
      }

      return message;
    });

    return `Configuration validation failed in ${filename}:\n${
      issues.join(
        "\n",
      )
    }\n\nPlease check your configuration file and ensure all required fields are present and valid.`;
  }

  private createDefaultAtlasConfig(): AtlasConfig {
    const defaultConfig: AtlasConfig = {
      version: "1.0",
      platform: {
        name: "Atlas",
        version: "1.0.0",
      },
      agents: {},
      supervisors: {
        workspace: {
          model: "claude-4-sonnet-20250514",
          prompts: {
            system:
              "You are a WorkspaceSupervisor responsible for analyzing signals and creating session contexts.",
          },
        },
        session: {
          model: "claude-4-sonnet-20250514",
          prompts: {
            system:
              "You are a SessionSupervisor responsible for coordinating agent execution within a session.",
          },
        },
        agent: {
          model: "claude-4-sonnet-20250514",
          prompts: {
            system: "You are an AgentSupervisor responsible for safe agent loading and execution.",
          },
        },
      },
    };

    // Validate the default config against the schema
    return AtlasConfigSchema.parse(defaultConfig);
  }

  // Convert workspace agent config to SessionSupervisor agent config
  convertToAgentConfig(
    workspaceAgentConfig: WorkspaceAgentConfig,
  ): AgentConfig {
    switch (workspaceAgentConfig.type) {
      case "tempest":
        return {
          type: "tempest",
          agent: workspaceAgentConfig.agent!,
          version: workspaceAgentConfig.version!,
          config: workspaceAgentConfig.config,
        } as TempestAgentConfig;

      case "llm":
        return {
          type: "llm",
          model: workspaceAgentConfig.model!,
          purpose: workspaceAgentConfig.purpose,
          tools: workspaceAgentConfig.tools,
          prompts: workspaceAgentConfig.prompts,
          mcp_servers: workspaceAgentConfig.mcp_servers,
          max_steps: workspaceAgentConfig.max_steps,
          tool_choice: workspaceAgentConfig.tool_choice,
        } as LLMAgentConfig;

      case "remote":
        return {
          type: "remote",
          protocol: workspaceAgentConfig.protocol!,
          endpoint: workspaceAgentConfig.endpoint!,
          auth: workspaceAgentConfig.auth,
          timeout: workspaceAgentConfig.timeout,
          schema: workspaceAgentConfig.schema,
          acp: workspaceAgentConfig.acp,
          mcp: workspaceAgentConfig.mcp,
          validation: workspaceAgentConfig.validation,
          monitoring: workspaceAgentConfig.monitoring,
        } as RemoteAgentConfig;

      default:
        throw new Error(`Unknown agent type: ${workspaceAgentConfig.type}`);
    }
  }
}
