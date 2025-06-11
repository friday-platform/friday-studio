/**
 * Configuration loader for Atlas that merges atlas.yml and workspace.yml
 */

import { parse as parseYaml } from "https://deno.land/std@0.208.0/yaml/mod.ts";
import { join } from "https://deno.land/std@0.208.0/path/mod.ts";
import type {
  AgentConfig,
  AgentType,
  JobSpecification,
  LLMAgentConfig,
  RemoteAgentConfig,
  TempestAgentConfig,
} from "./session-supervisor.ts";

// Atlas platform configuration (atlas.yml)
export interface AtlasConfig {
  version: string;
  workspaceSupervisor: {
    model: string;
    capabilities: string[];
    prompts: {
      system: string;
      signal_analysis: string;
      context_filtering: string;
      job_selection: string;
    };
  };
  sessionSupervisor: {
    model: string;
    capabilities: string[];
    prompts: {
      system: string;
      execution_planning: string;
      progress_evaluation: string;
      agent_coordination: string;
    };
  };
  agentSupervisor?: {
    model: string;
    capabilities: string[];
    prompts: {
      system: string;
      agent_analysis: string;
      environment_preparation: string;
      output_validation: string;
    };
  };
  platform: {
    version: string;
    api_version: string;
    defaults: {
      workspace_supervisor_model: string;
      session_supervisor_model: string;
      default_llm_model: string;
    };
    settings: {
      max_concurrent_sessions: number;
      session_timeout_minutes: number;
      agent_timeout_seconds: number;
      memory_retention_days: number;
      log_level: string;
    };
    tempest_agents?: {
      registry_url: string;
      version_policy: string;
      auto_update: boolean;
    };
    security: {
      worker_isolation: boolean;
      memory_isolation: boolean;
      network_isolation: boolean;
      audit_all_operations: boolean;
    };
  };
}

// New workspace configuration format
export interface NewWorkspaceConfig {
  version: string;
  workspace: {
    id: string;
    name: string;
    description: string;
  };
  agents: Record<string, WorkspaceAgentConfig>;
  signals: Record<string, WorkspaceSignalConfig>;
  runtime?: {
    server?: {
      port: number;
      host: string;
    };
    logging?: {
      level: string;
      format: string;
    };
    persistence?: {
      type: string;
      path: string;
    };
    security?: {
      cors: string;
    };
  };
}

export interface WorkspaceAgentConfig {
  type: AgentType;
  model?: string; // For LLM agents
  purpose: string;
  tools?: string[]; // For LLM agents
  prompts?: {
    system?: string;
    [key: string]: string | undefined;
  };
  // Tempest agent specific
  agent?: string; // Catalog reference
  version?: string;
  config?: Record<string, any>;
  // Remote agent specific
  endpoint?: string;
  auth?: {
    type: "bearer" | "api_key" | "basic";
    token_env?: string;
    [key: string]: any;
  };
  timeout?: number;
  schema?: {
    input?: Record<string, any>;
    output?: Record<string, any>;
  };
}

export interface WorkspaceSignalConfig {
  description: string;
  provider: string;
  schema?: {
    type: string;
    properties: Record<string, any>;
    required?: string[];
  };
  jobs: Array<{
    name: string;
    condition?: string;
    job: string; // Path to job file
  }>;
}

// Merged configuration that combines both
export interface MergedConfig {
  atlas: AtlasConfig;
  workspace: NewWorkspaceConfig;
  jobs: Record<string, JobSpecification>;
}

// Helper method to extract AgentSupervisor config from AtlasConfig
export function getAgentSupervisorConfig(atlasConfig: AtlasConfig): any {
  return {
    model: atlasConfig.agentSupervisor?.model ||
      atlasConfig.platform.defaults.session_supervisor_model,
    capabilities: atlasConfig.agentSupervisor?.capabilities || [],
    prompts: atlasConfig.agentSupervisor?.prompts || {},
    settings: atlasConfig.platform.settings,
    security: atlasConfig.platform.security,
  };
}

export class ConfigLoader {
  private atlasConfigPath: string;
  private workspaceConfigPath: string;
  private workspaceDir: string;

  constructor(workspaceDir: string = ".") {
    this.workspaceDir = workspaceDir;
    this.atlasConfigPath = join(workspaceDir, "atlas.yml");
    this.workspaceConfigPath = join(workspaceDir, "workspace.yml");
  }

  async load(): Promise<MergedConfig> {
    console.log("[ConfigLoader] Loading Atlas configuration...");

    // Load atlas.yml - platform configuration
    const atlasConfig = await this.loadAtlasConfig();

    // Load workspace.yml - user configuration
    const workspaceConfig = await this.loadWorkspaceConfig();

    // Load all job specifications
    const jobs = await this.loadJobSpecs(workspaceConfig);

    // Validate merged configuration
    this.validateConfig(atlasConfig, workspaceConfig);

    console.log("[ConfigLoader] Configuration loaded successfully");

    return {
      atlas: atlasConfig,
      workspace: workspaceConfig,
      jobs,
    };
  }

  private async loadAtlasConfig(): Promise<AtlasConfig> {
    try {
      const content = await Deno.readTextFile(this.atlasConfigPath);
      const config = parseYaml(content) as AtlasConfig;

      // Validate required fields
      if (!config.workspaceSupervisor || !config.sessionSupervisor) {
        throw new Error("Atlas configuration missing required supervisor configurations");
      }

      return config;
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        // Create default atlas.yml if it doesn't exist
        console.warn("[ConfigLoader] atlas.yml not found, using default configuration");
        return this.createDefaultAtlasConfig();
      }
      throw new Error(
        `Failed to load atlas.yml: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async loadWorkspaceConfig(): Promise<NewWorkspaceConfig> {
    try {
      const content = await Deno.readTextFile(this.workspaceConfigPath);
      const config = parseYaml(content) as NewWorkspaceConfig;

      // Validate required fields
      if (!config.workspace || !config.agents || !config.signals) {
        throw new Error("Workspace configuration missing required fields");
      }

      return config;
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        throw new Error("workspace.yml not found - this file is required");
      }
      throw new Error(
        `Failed to load workspace.yml: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async loadJobSpecs(
    workspaceConfig: NewWorkspaceConfig,
  ): Promise<Record<string, JobSpecification>> {
    const jobs: Record<string, JobSpecification> = {};

    // Collect all job file paths from signals
    const jobPaths = new Set<string>();
    for (const signal of Object.values(workspaceConfig.signals)) {
      for (const jobMapping of signal.jobs) {
        jobPaths.add(jobMapping.job);
      }
    }

    // Load each job specification
    for (const jobPath of jobPaths) {
      try {
        const fullPath = join(this.workspaceDir, jobPath);
        const content = await Deno.readTextFile(fullPath);
        const jobSpec = parseYaml(content) as { job: JobSpecification };

        if (!jobSpec.job || !jobSpec.job.name) {
          throw new Error(`Invalid job specification in ${jobPath}`);
        }

        jobs[jobSpec.job.name] = jobSpec.job;
        console.log(`[ConfigLoader] Loaded job: ${jobSpec.job.name}`);
      } catch (error) {
        console.error(
          `[ConfigLoader] Failed to load job from ${jobPath}:`,
          error instanceof Error ? error.message : String(error),
        );
        // Continue loading other jobs
      }
    }

    return jobs;
  }

  private validateConfig(atlasConfig: AtlasConfig, workspaceConfig: NewWorkspaceConfig): void {
    // Validate agent configurations
    for (const [agentId, agentConfig] of Object.entries(workspaceConfig.agents)) {
      this.validateAgentConfig(agentId, agentConfig);
    }

    // Validate signal configurations
    for (const [signalId, signalConfig] of Object.entries(workspaceConfig.signals)) {
      this.validateSignalConfig(signalId, signalConfig);
    }

    console.log("[ConfigLoader] Configuration validation passed");
  }

  private validateAgentConfig(agentId: string, config: WorkspaceAgentConfig): void {
    if (!config.type || !["tempest", "llm", "remote"].includes(config.type)) {
      throw new Error(
        `Agent ${agentId}: Invalid type '${config.type}'. Must be 'tempest', 'llm', or 'remote'`,
      );
    }

    switch (config.type) {
      case "tempest":
        if (!config.agent || !config.version) {
          throw new Error(`Agent ${agentId}: Tempest agents require 'agent' and 'version' fields`);
        }
        break;
      case "llm":
        if (!config.model) {
          throw new Error(`Agent ${agentId}: LLM agents require 'model' field`);
        }
        break;
      case "remote":
        if (!config.endpoint) {
          throw new Error(`Agent ${agentId}: Remote agents require 'endpoint' field`);
        }
        break;
    }
  }

  private validateSignalConfig(signalId: string, config: WorkspaceSignalConfig): void {
    if (!config.provider) {
      throw new Error(`Signal ${signalId}: Missing 'provider' field`);
    }

    if (!config.jobs || config.jobs.length === 0) {
      throw new Error(`Signal ${signalId}: Must have at least one job mapping`);
    }

    for (const jobMapping of config.jobs) {
      if (!jobMapping.name || !jobMapping.job) {
        throw new Error(`Signal ${signalId}: Job mappings require 'name' and 'job' fields`);
      }
    }
  }

  private createDefaultAtlasConfig(): AtlasConfig {
    return {
      version: "1.0",
      workspaceSupervisor: {
        model: "claude-4-sonnet-20250514",
        capabilities: ["signal_analysis", "context_filtering", "session_spawning", "job_selection"],
        prompts: {
          system:
            "You are a WorkspaceSupervisor responsible for analyzing signals and creating session contexts.",
          signal_analysis: "Analyze incoming signals to understand intent and requirements.",
          context_filtering: "Create filtered contexts for sessions with relevant workspace data.",
          job_selection: "Select appropriate jobs to execute based on signal analysis.",
        },
      },
      sessionSupervisor: {
        model: "claude-4-sonnet-20250514",
        capabilities: ["execution_planning", "agent_coordination", "progress_evaluation"],
        prompts: {
          system:
            "You are a SessionSupervisor responsible for coordinating agent execution within a session.",
          execution_planning:
            "Create execution plans based on job specifications and session context.",
          progress_evaluation: "Evaluate agent outputs and session progress.",
          agent_coordination: "Coordinate different agent types with appropriate interfaces.",
        },
      },
      platform: {
        version: "1.0.0",
        api_version: "v1",
        defaults: {
          workspace_supervisor_model: "claude-4-sonnet-20250514",
          session_supervisor_model: "claude-4-sonnet-20250514",
          default_llm_model: "claude-4-sonnet-20250514",
        },
        settings: {
          max_concurrent_sessions: 10,
          session_timeout_minutes: 30,
          agent_timeout_seconds: 300,
          memory_retention_days: 30,
          log_level: "info",
        },
        security: {
          worker_isolation: true,
          memory_isolation: true,
          network_isolation: false,
          audit_all_operations: true,
        },
      },
    };
  }

  // Convert workspace agent config to SessionSupervisor agent config
  convertToAgentConfig(workspaceAgentConfig: WorkspaceAgentConfig): AgentConfig {
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
          endpoint: workspaceAgentConfig.endpoint!,
          auth: workspaceAgentConfig.auth,
          timeout: workspaceAgentConfig.timeout,
          schema: workspaceAgentConfig.schema,
        } as RemoteAgentConfig;

      default:
        throw new Error(`Unknown agent type: ${workspaceAgentConfig.type}`);
    }
  }
}
