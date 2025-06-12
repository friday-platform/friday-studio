/**
 * Atlas Configuration Loader
 *
 * Loads and validates atlas.yml configuration including memory settings,
 * supervisor configuration, and platform agents.
 */

import { parse } from "https://deno.land/std@0.208.0/yaml/mod.ts";
import { exists } from "https://deno.land/std@0.208.0/fs/mod.ts";
import type { AtlasMemoryConfig } from "./memory-config.ts";
import { logger } from "../utils/logger.ts";

export interface AtlasPlatformConfig {
  name: string;
  version: string;
}

export interface AtlasAgentConfig {
  type: "llm" | "tempest" | "remote";
  model?: string;
  purpose: string;
  tools?: string[];
  prompts?: {
    system?: string;
    [key: string]: string | undefined;
  };
  endpoint?: string;
  auth?: {
    type: string;
    token_env?: string;
    [key: string]: any;
  };
  timeout?: number;
  schema?: {
    input?: Record<string, any>;
    output?: Record<string, any>;
  };
  agent?: string;
  version?: string;
  config?: Record<string, any>;
}

export interface AtlasSupervisorConfig {
  model: string;
  memory?: string;
  prompts: {
    system: string;
    [key: string]: string;
  };
}

export interface AtlasConfiguration {
  version: string;
  platform: AtlasPlatformConfig;
  memory: AtlasMemoryConfig;
  agents: Record<string, AtlasAgentConfig>;
  supervisors: {
    workspace: AtlasSupervisorConfig;
    session: AtlasSupervisorConfig;
    agent: AtlasSupervisorConfig;
  };
}

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
      const parsedConfig = parse(yamlText) as any;

      // Validate and transform configuration
      this.config = this.validateAndTransformConfig(parsedConfig);

      logger.info("Atlas configuration loaded", {
        version: this.config.version,
        platform: this.config.platform.name,
        agents: Object.keys(this.config.agents).length,
        memoryEnabled: this.config.memory.default.enabled,
      });

      return this.config;
    } catch (error) {
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

  private validateAndTransformConfig(parsedConfig: any): AtlasConfiguration {
    // Validate required fields
    if (!parsedConfig.version) {
      throw new Error("Missing required field: version");
    }

    // Set defaults for missing sections
    const config: AtlasConfiguration = {
      version: parsedConfig.version,
      platform: parsedConfig.platform || {
        name: "Atlas",
        version: "1.0.0",
      },
      memory: parsedConfig.memory || this.getMinimalMemoryConfig(),
      agents: parsedConfig.agents || {},
      supervisors: parsedConfig.supervisors || this.getMinimalSupervisorConfig(),
    };

    // Validate memory configuration
    this.validateMemoryConfig(config.memory);

    return config;
  }

  private validateMemoryConfig(memoryConfig: AtlasMemoryConfig): void {
    const requiredScopes = ["agent", "session", "workspace"];

    for (const scope of requiredScopes) {
      if (!memoryConfig[scope as keyof AtlasMemoryConfig]) {
        throw new Error(`Missing memory configuration for scope: ${scope}`);
      }
    }

    // Validate memory type configurations
    for (const scope of requiredScopes) {
      const scopeConfig = memoryConfig[scope as keyof AtlasMemoryConfig] as any;
      if (scopeConfig.enabled && !scopeConfig.memory_types) {
        throw new Error(`Missing memory_types configuration for scope: ${scope}`);
      }
    }
  }

  private async getDefaultConfiguration(): Promise<AtlasConfiguration> {
    try {
      // Load defaults from YAML file
      const defaultsPath = new URL("../config/defaults.yml", import.meta.url).pathname;
      const defaultsYaml = await Deno.readTextFile(defaultsPath);
      const defaults = parse(defaultsYaml) as any;

      return this.validateAndTransformConfig(defaults);
    } catch (error) {
      logger.error("Failed to load defaults.yml, using minimal fallback", {
        error: error instanceof Error ? error.message : String(error),
      });

      // Minimal fallback if defaults.yml is missing
      return {
        version: "1.0",
        platform: { name: "Atlas", version: "1.0.0" },
        memory: this.getMinimalMemoryConfig(),
        agents: {},
        supervisors: this.getMinimalSupervisorConfig(),
      };
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
   * Get configuration file path
   */
  getConfigPath(): string {
    return this.configPath;
  }
}
