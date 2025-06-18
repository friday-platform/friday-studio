/**
 * Atlas Configuration Loader
 *
 * Loads and validates atlas.yml configuration including memory settings,
 * supervisor configuration, and platform agents.
 */

import { exists } from "@std/fs";
import { parse } from "@std/yaml";
import { z } from "zod/v4";
import { logger } from "../utils/logger.ts";
import type { AtlasMemoryConfig } from "./memory-config.ts";

// Custom error class for atlas configuration validation
export class AtlasConfigValidationError extends Error {
  constructor(
    message: string,
    public file: string,
    public field?: string,
    public value?: unknown,
  ) {
    super(message);
    this.name = "AtlasConfigValidationError";
  }
}

// Zod schemas for validation
const AtlasPlatformConfigSchema = z.object({
  name: z.string().min(1, "Platform name cannot be empty"),
  version: z.string().min(1, "Platform version cannot be empty"),
});

const AtlasAgentTypeSchema = z.enum(["llm", "tempest", "remote"]);

const AtlasAuthConfigSchema = z
  .object({
    type: z.enum(["bearer", "api_key", "basic", "none"]),
    token_env: z.string().optional(),
    token: z.string().optional(),
    api_key_env: z.string().optional(),
    api_key: z.string().optional(),
    header: z.string().default("Authorization"),
  })
  .catchall(z.any());

const AtlasSchemaConfigSchema = z.object({
  input: z.record(z.string(), z.any()).optional(),
  output: z.record(z.string(), z.any()).optional(),
});

const AtlasAgentConfigSchema = z
  .object({
    type: AtlasAgentTypeSchema,
    model: z.string().optional(),
    purpose: z.string().min(1, "Agent purpose cannot be empty"),
    tools: z.array(z.string()).optional(),
    prompts: z
      .object({
        system: z.string().optional(),
      })
      .catchall(z.string())
      .optional(),
    endpoint: z.url().optional(),
    auth: AtlasAuthConfigSchema.optional(),
    timeout: z.number().positive().optional(),
    schema: AtlasSchemaConfigSchema.optional(),
    agent: z.string().optional(),
    version: z.string().optional(),
    config: z.record(z.string(), z.any()).optional(),
  })
  .check((ctx) => {
    // Type-specific validation
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
    }
  });

const AtlasSupervisionConfigSchema = z.object({
  level: z.enum(["minimal", "standard", "paranoid"]).default("standard"),
  cache_enabled: z.boolean().default(true),
  cache_adapter: z.enum(["memory", "redis", "file"]).default("memory"),
  cache_ttl_hours: z.number().positive().default(1),
  parallel_llm_calls: z.boolean().default(true),
  timeouts: z.object({
    analysis_ms: z.number().positive().default(10000),
    validation_ms: z.number().positive().default(8000),
  }).optional(),
}).optional();

const AtlasSupervisorConfigSchema = z.object({
  model: z.string().min(1, "Supervisor model cannot be empty"),
  memory: z.string().optional(),
  supervision: AtlasSupervisionConfigSchema,
  prompts: z
    .object({
      system: z.string().min(1, "System prompt cannot be empty"),
    })
    .catchall(z.string()),
});

// Memory configuration schemas (basic validation)
const AtlasMemoryRetentionSchema = z.object({
  max_age_days: z.number().positive(),
  max_entries: z.number().positive(),
  cleanup_interval_hours: z.number().positive(),
});

const AtlasMemoryDefaultSchema = z.object({
  enabled: z.boolean(),
  storage: z.string(),
  cognitive_loop: z.boolean(),
  retention: AtlasMemoryRetentionSchema,
});

const AtlasMemoryContextLimitsSchema = z.object({
  relevant_memories: z.number().min(0),
  past_successes: z.number().min(0),
  past_failures: z.number().min(0),
});

const AtlasMemoryScopeSchema = z.object({
  enabled: z.boolean(),
  scope: z.enum(["agent", "session", "workspace"]),
  include_in_context: z.boolean(),
  context_limits: AtlasMemoryContextLimitsSchema,
  memory_types: z.record(z.string(), z.any()),
});

const AtlasMemoryStreamingSchema = z.object({
  enabled: z.boolean().default(true),
  queue_max_size: z.number().positive().default(1000),
  batch_size: z.number().positive().default(10),
  flush_interval_ms: z.number().positive().default(1000),
  background_processing: z.boolean().default(true),
  persistence_enabled: z.boolean().default(true),
  error_retry_attempts: z.number().min(0).default(3),
  priority_processing: z.boolean().default(true),
  dual_write_enabled: z.boolean().default(true),
  legacy_batch_enabled: z.boolean().default(false),
  stream_everything: z.boolean().default(true),
  performance_tracking: z.boolean().default(true),
}).optional();

const AtlasMemoryConfigSchema = z.object({
  default: AtlasMemoryDefaultSchema,
  streaming: AtlasMemoryStreamingSchema,
  agent: AtlasMemoryScopeSchema,
  session: AtlasMemoryScopeSchema,
  workspace: AtlasMemoryScopeSchema,
});

const AtlasConfigurationSchema = z.object({
  version: z.string().min(1, "Version cannot be empty"),
  platform: AtlasPlatformConfigSchema,
  memory: AtlasMemoryConfigSchema,
  agents: z.record(z.string(), AtlasAgentConfigSchema),
  supervisors: z.object({
    workspace: AtlasSupervisorConfigSchema,
    session: AtlasSupervisorConfigSchema,
    agent: AtlasSupervisorConfigSchema,
  }),
});

// Inferred types from Zod schemas
export type AtlasPlatformConfig = z.infer<typeof AtlasPlatformConfigSchema>;
export type AtlasAgentConfig = z.infer<typeof AtlasAgentConfigSchema>;
export type AtlasSupervisionConfig = z.infer<typeof AtlasSupervisionConfigSchema>;
export type AtlasSupervisorConfig = z.infer<typeof AtlasSupervisorConfigSchema>;
export type AtlasConfiguration = z.infer<typeof AtlasConfigurationSchema>;

export class AtlasConfigLoader {
  private static instance?: AtlasConfigLoader;
  private config?: AtlasConfiguration;
  private configPath: string;

  constructor(configPath: string = "./atlas.yml") {
    this.configPath = configPath;
  }

  static getInstance(configPath?: string): AtlasConfigLoader {
    if (!AtlasConfigLoader.instance) {
      AtlasConfigLoader.instance = new AtlasConfigLoader(configPath);
    }
    return AtlasConfigLoader.instance;
  }

  async loadConfiguration(): Promise<AtlasConfiguration> {
    if (this.config) {
      return this.config;
    }

    try {
      // Check if atlas.yml exists
      if (!(await exists(this.configPath))) {
        logger.warn("atlas.yml not found, using default configuration");
        this.config = await this.getDefaultConfiguration();
        return this.config;
      }

      // Load and parse atlas.yml
      const yamlText = await Deno.readTextFile(this.configPath);
      const parsedConfig = parse(yamlText);

      // Validate with Zod
      this.config = AtlasConfigurationSchema.parse(parsedConfig);

      logger.info("Atlas configuration loaded", {
        version: this.config.version,
        platform: this.config.platform.name,
        agents: Object.keys(this.config.agents).length,
        memoryEnabled: this.config.memory.default.enabled,
      });

      return this.config;
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw new AtlasConfigValidationError(
          this.formatZodError(error, "atlas.yml"),
          "atlas.yml",
        );
      }

      logger.error("Failed to load atlas.yml configuration", {
        error: error instanceof Error ? error.message : String(error),
        configPath: this.configPath,
      });

      // Fallback to default configuration
      this.config = await this.getDefaultConfiguration();
      return this.config;
    }
  }

  getMemoryConfiguration(): AtlasMemoryConfig {
    if (!this.config) {
      throw new Error("Configuration not loaded. Call loadConfiguration() first.");
    }
    return this.config.memory;
  }

  getSupervisorConfiguration(type: "workspace" | "session" | "agent"): AtlasSupervisorConfig {
    if (!this.config) {
      throw new Error("Configuration not loaded. Call loadConfiguration() first.");
    }
    return this.config.supervisors[type];
  }

  getPlatformAgents(): Record<string, AtlasAgentConfig> {
    if (!this.config) {
      throw new Error("Configuration not loaded. Call loadConfiguration() first.");
    }
    return this.config.agents;
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

    return `Atlas configuration validation failed in ${filename}:\n${
      issues.join(
        "\n",
      )
    }\n\nPlease check your atlas.yml file and ensure all required fields are present and valid.`;
  }

  private async getDefaultConfiguration(): Promise<AtlasConfiguration> {
    try {
      // Load defaults from YAML file
      const defaultsPath = new URL("../config/defaults.yml", import.meta.url).pathname;
      const defaultsYaml = await Deno.readTextFile(defaultsPath);
      const defaults = parse(defaultsYaml);

      // Validate with Zod
      return AtlasConfigurationSchema.parse(defaults);
    } catch (error) {
      logger.error("Failed to load defaults.yml, using minimal fallback", {
        error: error instanceof Error ? error.message : String(error),
      });

      // Minimal fallback if defaults.yml is missing
      const fallbackConfig = {
        version: "1.0",
        platform: { name: "Atlas", version: "1.0.0" },
        memory: this.getMinimalMemoryConfig(),
        agents: {},
        supervisors: this.getMinimalSupervisorConfig(),
      };

      // Validate the fallback config with Zod
      return AtlasConfigurationSchema.parse(fallbackConfig);
    }
  }

  private getMinimalMemoryConfig(): AtlasMemoryConfig {
    // Minimal memory config when everything fails
    return {
      default: {
        enabled: true,
        storage: "coala-local",
        cognitive_loop: false,
        retention: { max_age_days: 1, max_entries: 10, cleanup_interval_hours: 1 },
      },
      agent: {
        enabled: false,
        scope: "agent",
        include_in_context: false,
        context_limits: { relevant_memories: 0, past_successes: 0, past_failures: 0 },
        memory_types: {},
      },
      session: {
        enabled: false,
        scope: "session",
        include_in_context: false,
        context_limits: { relevant_memories: 0, past_successes: 0, past_failures: 0 },
        memory_types: {},
      },
      workspace: {
        enabled: false,
        scope: "workspace",
        include_in_context: false,
        context_limits: { relevant_memories: 0, past_successes: 0, past_failures: 0 },
        memory_types: {},
      },
    };
  }

  private getMinimalSupervisorConfig() {
    return {
      workspace: {
        model: "claude-3-5-sonnet-20241022",
        memory: "workspace",
        prompts: { system: "You are a WorkspaceSupervisor." },
      },
      session: {
        model: "claude-3-5-sonnet-20241022",
        memory: "session",
        prompts: { system: "You are a SessionSupervisor." },
      },
      agent: {
        model: "claude-3-5-sonnet-20241022",
        memory: "agent",
        prompts: { system: "You are an AgentSupervisor." },
      },
    };
  }

  /**
   * Reload configuration from disk
   */
  async reloadConfiguration(): Promise<AtlasConfiguration> {
    this.config = undefined;
    return await this.loadConfiguration();
  }

  /**
   * Validate a configuration object against the schema
   */
  validateConfiguration(config: unknown): AtlasConfiguration {
    return AtlasConfigurationSchema.parse(config);
  }

  /**
   * Get configuration file path
   */
  getConfigPath(): string {
    return this.configPath;
  }
}
