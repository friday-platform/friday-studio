/**
 * Configuration loader for Atlas that merges atlas.yml and workspace.yml
 */

import { parse as parseYaml } from "https://deno.land/std@0.208.0/yaml/mod.ts";
import { join } from "https://deno.land/std@0.208.0/path/mod.ts";
import { logger } from "../utils/logger.ts";
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
  platform: {
    name: string;
    version: string;
    api_version?: string;
    defaults?: {
      workspace_supervisor_model?: string;
      session_supervisor_model?: string;
      default_llm_model?: string;
    };
    settings?: {
      max_concurrent_sessions?: number;
      session_timeout_minutes?: number;
      agent_timeout_seconds?: number;
      memory_retention_days?: number;
      log_level?: string;
    };
    security?: {
      require_authentication?: boolean;
      allowed_origins?: string[];
      rate_limiting?: boolean;
      worker_isolation?: boolean;
      memory_isolation?: boolean;
      network_isolation?: boolean;
      audit_all_operations?: boolean;
    };
  };
  agents?: Record<string, AgentConfig>;
  supervisors: {
    workspace: {
      model: string;
      prompts: {
        system: string;
      };
    };
    session: {
      model: string;
      prompts: {
        system: string;
      };
    };
    agent: {
      model: string;
      prompts: {
        system: string;
      };
    };
  };
  // Legacy fields for backward compatibility
  workspaceSupervisor?: any;
  sessionSupervisor?: any;
  agentSupervisor?: any;
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
    description?: string;
    job?: string; // Path to job file
    execution?: {
      strategy: "sequential" | "parallel" | "conditional" | "staged";
      agents: Array<{
        id: string;
        mode?: string;
        prompt?: string;
        config?: Record<string, any>;
        input?: Record<string, any>;
      }>;
      stages?: Array<{
        name: string;
        strategy: "sequential" | "parallel";
        agents: Array<{
          id: string;
          mode?: string;
          prompt?: string;
          config?: Record<string, any>;
          input?: Record<string, any>;
        }>;
      }>;
    };
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
      atlasConfig.platform.defaults?.session_supervisor_model,
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
    this.validateConfig(atlasConfig, workspaceConfig);

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
      if (!config.supervisors?.workspace || !config.supervisors?.session) {
        throw new Error("Atlas configuration missing required supervisor configurations");
      }

      return config;
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        // Create default atlas.yml if it doesn't exist
        logger.warn("atlas.yml not found, using default configuration");
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

    // Collect all job specs from signals (both inline and file references)
    const jobPaths = new Set<string>();
    for (const signal of Object.values(workspaceConfig.signals)) {
      for (const jobMapping of signal.jobs) {
        if (jobMapping.job) {
          // File reference - add to paths to load
          jobPaths.add(jobMapping.job);
        } else if (jobMapping.execution) {
          // Inline job spec - add directly
          jobs[jobMapping.name] = {
            name: jobMapping.name,
            description: jobMapping.description || `Job for ${jobMapping.name}`,
            execution: jobMapping.execution,
          };
        }
      }
    }

    // Load job specifications from files
    for (const jobPath of jobPaths) {
      try {
        const fullPath = join(this.workspaceDir, jobPath);
        const content = await Deno.readTextFile(fullPath);
        const jobSpec = parseYaml(content) as { job: JobSpecification };

        if (!jobSpec.job || !jobSpec.job.name) {
          throw new Error(`Invalid job specification in ${jobPath}`);
        }

        jobs[jobSpec.job.name] = jobSpec.job;
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
      if (!jobMapping.name) {
        throw new Error(`Signal ${signalId}: Job mappings require 'name' field`);
      }
      // Support both inline job specs and file references
      if (!jobMapping.job && !jobMapping.execution) {
        throw new Error(
          `Signal ${signalId}: Job mappings require either 'job' (file path) or 'execution' (inline spec) field`,
        );
      }

      // Validate inline execution if provided
      if (jobMapping.execution) {
        if (!jobMapping.execution.strategy) {
          throw new Error(`Signal ${signalId}: Inline job execution requires 'strategy' field`);
        }
        if (!jobMapping.execution.agents || jobMapping.execution.agents.length === 0) {
          throw new Error(`Signal ${signalId}: Inline job execution requires at least one agent`);
        }
        for (const agent of jobMapping.execution.agents) {
          if (!agent.id) {
            throw new Error(`Signal ${signalId}: Job execution agents require 'id' field`);
          }
        }
      }
    }
  }

  private createDefaultAtlasConfig(): AtlasConfig {
    return {
      version: "1.0",
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
            system: "You are an AgentSupervisor responsible for safe agent execution.",
          },
        },
      },
      platform: {
        name: "Atlas",
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
