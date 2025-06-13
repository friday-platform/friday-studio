/**
 * Configuration loader for Atlas that merges atlas.yml and workspace.yml
 */

import { parse as parseYaml } from "@std/yaml";
import { join } from "@std/path";
import { z } from "zod/v4";
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

// MCP-specific configuration schema
const MCPConfigSchema = z.object({
  timeout_ms: z.number().positive().default(30000),
  allowed_tools: z.array(z.string()).optional(),
  denied_tools: z.array(z.string()).optional(),
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
    model: z.string().optional(),
    purpose: z.string(),
    tools: z.array(z.string()).optional(),
    prompts: z.record(z.string(), z.string()).optional(),
    // Tempest agent specific
    agent: z.string().optional(),
    version: z.string().optional(),
    config: z.record(z.string(), z.any()).optional(),
    // Remote agent specific
    protocol: z.enum(["acp", "a2a", "custom", "mcp"]).optional(),
    endpoint: z.url().optional(),
    auth: AuthConfigSchema.optional(),
    timeout: z.number().positive().optional(),

    // Protocol-specific configurations
    acp: ACPConfigSchema.optional(),
    a2a: z.record(z.string(), z.any()).optional(), // Placeholder for A2A
    custom: z.record(z.string(), z.any()).optional(), // Placeholder for custom
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
  .check((ctx) => {
    // Type-specific validation with detailed error messages
    if (ctx.value.type === "tempest") {
      if (!ctx.value.agent) {
        ctx.issues.push({
          code: "custom",
          message: "Tempest agents require 'agent' field",
          path: ["agent"],
          input: ctx.value,
        });
      }
      if (!ctx.value.version) {
        ctx.issues.push({
          code: "custom",
          message: "Tempest agents require 'version' field",
          path: ["version"],
          input: ctx.value,
        });
      }
    } else if (ctx.value.type === "llm") {
      if (!ctx.value.model) {
        ctx.issues.push({
          code: "custom",
          message: "LLM agents require 'model' field",
          path: ["model"],
          input: ctx.value,
        });
      }
    } else if (ctx.value.type === "remote") {
      if (!ctx.value.endpoint) {
        ctx.issues.push({
          code: "custom",
          message: "Remote agents require 'endpoint' field",
          path: ["endpoint"],
          input: ctx.value,
        });
      }

      if (!ctx.value.protocol) {
        ctx.issues.push({
          code: "custom",
          message: "Remote agents require 'protocol' field (acp, a2a, custom, or mcp)",
          path: ["protocol"],
          input: ctx.value,
        });
      }

      // Protocol-specific validation
      if (ctx.value.protocol === "acp") {
        if (!ctx.value.acp?.agent_name) {
          ctx.issues.push({
            code: "custom",
            message: "ACP remote agents require 'acp.agent_name' field",
            path: ["acp", "agent_name"],
            input: ctx.value,
          });
        }
      } else if (ctx.value.protocol === "mcp") {
        // MCP doesn't require specific fields beyond endpoint
        // Optional tools filtering can be configured via mcp.allowed_tools/denied_tools
      }

      // Authentication validation
      if (ctx.value.auth) {
        const authType = ctx.value.auth.type;
        if (authType === "bearer" && !ctx.value.auth.token_env && !ctx.value.auth.token) {
          ctx.issues.push({
            code: "custom",
            message: "Bearer auth requires either 'token_env' or 'token' field",
            path: ["auth"],
            input: ctx.value,
          });
        }
        if (authType === "api_key" && !ctx.value.auth.api_key_env && !ctx.value.auth.token_env) {
          ctx.issues.push({
            code: "custom",
            message: "API key auth requires either 'api_key_env' or 'token_env' field",
            path: ["auth"],
            input: ctx.value,
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

// Inline job specification schema
const InlineJobSchema = z.object({
  name: z.string(),
  condition: z.string().optional(),
  description: z.string().optional(),
  execution: JobExecutionSchema,
});

// Job reference schema (pointing to external file)
const JobReferenceSchema = z.object({
  name: z.string(),
  condition: z.string().optional(),
  job: z.string(),
});

const WorkspaceSignalConfigSchema = z.object({
  description: z.string(),
  provider: z.string(),
  schema: SchemaObjectSchema.optional(),
  jobs: z
    .array(
      z.union([
        InlineJobSchema,
        JobReferenceSchema,
      ]),
    )
    .min(1, "Signal must have at least one job mapping"),
});

const NewWorkspaceConfigSchema = z.object({
  version: z.string(),
  workspace: z.object({
    id: z.uuid("Workspace ID must be a valid UUID"),
    name: z.string().min(1, "Workspace name cannot be empty"),
    description: z.string(),
  }),
  agents: z.record(z.string(), WorkspaceAgentConfigSchema),
  signals: z.record(z.string(), WorkspaceSignalConfigSchema),
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
});

// Inferred types from Zod schemas
export type AtlasConfig = z.infer<typeof AtlasConfigSchema>;
export type NewWorkspaceConfig = z.infer<typeof NewWorkspaceConfigSchema>;
export type WorkspaceAgentConfig = z.infer<typeof WorkspaceAgentConfigSchema>;
export type WorkspaceSignalConfig = z.infer<typeof WorkspaceSignalConfigSchema>;

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
    // Get git root directory to find atlas.yml
    const gitRoot = new Deno.Command("git", {
      args: ["rev-parse", "--show-toplevel"],
      stdout: "piped",
    }).outputSync();
    const rootDir = new TextDecoder().decode(gitRoot.stdout).trim();

    this.atlasConfigPath = join(rootDir, "atlas.yml");
    this.workspaceConfigPath = join(workspaceDir, "workspace.yml");
  }

  async load(): Promise<MergedConfig> {
    // Load atlas.yml - platform configuration
    const atlasConfig = await this.loadAtlasConfig();

    // Load workspace.yml - user configuration
    const workspaceConfig = await this.loadWorkspaceConfig();

    // Load all job specifications
    const jobs = await this.loadJobSpecs(workspaceConfig);

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

  private async loadJobSpecs(
    workspaceConfig: NewWorkspaceConfig,
  ): Promise<Record<string, JobSpecification>> {
    const jobs: Record<string, JobSpecification> = {};

    // Process jobs from all signals
    for (const signal of Object.values(workspaceConfig.signals)) {
      for (const jobMapping of signal.jobs) {
        // Check if this is an inline job or a job file reference
        if ("job" in jobMapping) {
          // This is a job file reference
          try {
            const fullPath = join(this.workspaceDir, jobMapping.job);
            const content = await Deno.readTextFile(fullPath);
            const jobSpec = parseYaml(content) as { job: JobSpecification };

            if (!jobSpec.job || !jobSpec.job.name) {
              throw new Error(`Invalid job specification in ${jobMapping.job}`);
            }

            jobs[jobSpec.job.name] = jobSpec.job;
          } catch (error) {
            console.error(
              `[ConfigLoader] Failed to load job from ${jobMapping.job}:`,
              error instanceof Error ? error.message : String(error),
            );
            // Continue loading other jobs
          }
        } else if ("execution" in jobMapping) {
          // This is an inline job definition
          // Normalize string agents to JobAgentSpec objects
          const normalizedAgents = jobMapping.execution.agents.map((agent) => {
            if (typeof agent === "string") {
              return { id: agent };
            }
            return agent;
          });

          const jobSpec: JobSpecification = {
            name: jobMapping.name,
            description: jobMapping.description || `Inline job: ${jobMapping.name}`,
            execution: {
              strategy: jobMapping.execution.strategy,
              agents: normalizedAgents,
            },
          };

          jobs[jobMapping.name] = jobSpec;
        }
      }
    }

    return jobs;
  }

  private validateConfig(
    atlasConfig: AtlasConfig,
    workspaceConfig: NewWorkspaceConfig,
    jobs: Record<string, JobSpecification>,
  ): void {
    // Cross-validate job references in signals
    for (
      const [signalId, signalConfig] of Object.entries(
        workspaceConfig.signals,
      )
    ) {
      for (const jobMapping of signalConfig.jobs) {
        // Find the job specification either by name or loaded from file
        const jobSpec = Object.values(jobs).find(
          (job) => job.name === jobMapping.name,
        );

        if (!jobSpec) {
          const jobSource = "job" in jobMapping
            ? `job file '${jobMapping.job}'`
            : "inline definition";
          throw new ConfigValidationError(
            `Signal '${signalId}' references job '${jobMapping.name}' which was not found in ${jobSource}`,
            "workspace.yml",
            `signals.${signalId}.jobs`,
            jobMapping,
          );
        }

        // Validate that agents referenced in job exist in workspace
        if (jobSpec.execution?.agents) {
          for (const agentRef of jobSpec.execution.agents) {
            const agentId = typeof agentRef === "string" ? agentRef : agentRef.id;
            if (
              !workspaceConfig.agents[agentId] &&
              !atlasConfig.agents[agentId]
            ) {
              const jobSource = "job" in jobMapping ? jobMapping.job : "inline job definition";
              throw new ConfigValidationError(
                `Job '${jobSpec.name}' references agent '${agentId}' which is not defined in workspace or atlas agents`,
                jobSource,
                "execution.agents",
                agentRef,
              );
            }
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
          a2a: workspaceAgentConfig.a2a,
          custom: workspaceAgentConfig.custom,
          mcp: workspaceAgentConfig.mcp,
          validation: workspaceAgentConfig.validation,
          monitoring: workspaceAgentConfig.monitoring,
        } as RemoteAgentConfig;

      default:
        throw new Error(`Unknown agent type: ${workspaceAgentConfig.type}`);
    }
  }
}
