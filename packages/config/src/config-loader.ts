/**
 * Configuration loader for Atlas using dependency injection
 * Loads and validates atlas.yml and workspace.yml configurations
 */

import { join } from "@std/path";
import type { ConfigurationAdapter } from "@atlas/storage";
import { logger } from "../../../src/utils/logger.ts";
import {
  AtlasConfig,
  AtlasConfigSchema,
  JobSpecification,
  JobSpecificationSchema,
  MergedConfig,
  SupervisorDefaults,
  SupervisorDefaultsSchema,
  type WorkspaceAgentConfig,
  WorkspaceConfig,
  WorkspaceConfigSchema,
} from "./schemas.ts";
import { ConfigValidationError, formatZodError } from "./validation.ts";
import { z } from "zod/v4";
import type {
  AgentConfig,
  LLMAgentConfig,
  RemoteAgentConfig,
  TempestAgentConfig,
} from "../../../src/core/session-supervisor.ts";

/**
 * Configuration loader with dependency injection
 * Uses adapter pattern for all I/O operations
 */
export class ConfigLoader {
  constructor(
    private adapter: ConfigurationAdapter,
    private workspaceDir: string = ".",
  ) {}

  /**
   * Load and merge all configuration files
   */
  async load(): Promise<MergedConfig> {
    // Load supervisor defaults first
    const rawSupervisorDefaults = await this.adapter.loadSupervisorDefaults();
    const supervisorDefaults = SupervisorDefaultsSchema.parse(rawSupervisorDefaults);

    // Load atlas.yml - platform configuration
    const atlasConfig = await this.loadAtlasConfig();

    // Merge supervisor defaults with atlas config
    const mergedAtlasConfig = this.mergeSupervisorDefaults(
      atlasConfig,
      supervisorDefaults,
    );

    // Load workspace.yml - user configuration
    const workspaceConfig = await this.loadWorkspaceConfig();

    // Load all job specifications
    const jobs = await this.loadJobSpecs(workspaceConfig);

    // Validate merged configuration
    this.validateConfig(mergedAtlasConfig, workspaceConfig, jobs);

    return {
      atlas: mergedAtlasConfig,
      workspace: workspaceConfig,
      jobs,
      supervisorDefaults,
    };
  }

  /**
   * Load atlas.yml configuration
   */
  private async loadAtlasConfig(): Promise<AtlasConfig> {
    const atlasPath = await this.adapter.resolveAtlasConfigPath(this.workspaceDir);

    try {
      const rawConfig = await this.adapter.loadYamlFile(atlasPath);
      return AtlasConfigSchema.parse(rawConfig);
    } catch (error) {
      if (error instanceof Error && error.message.includes("NotFound")) {
        logger.warn(
          "[ConfigLoader] atlas.yml not found, using default configuration",
        );
        return await this.createDefaultAtlasConfig();
      }
      throw this.handleConfigError(error, "atlas.yml");
    }
  }

  /**
   * Load workspace.yml configuration
   */
  private async loadWorkspaceConfig(): Promise<WorkspaceConfig> {
    const workspacePath = await this.adapter.resolveWorkspaceConfigPath(
      this.workspaceDir,
    );

    try {
      const rawConfig = await this.adapter.loadYamlFile(workspacePath);
      return WorkspaceConfigSchema.parse(rawConfig);
    } catch (error) {
      if (error instanceof Error && error.message.includes("NotFound")) {
        throw new ConfigValidationError(
          "workspace.yml not found - this file is required",
          "workspace.yml",
        );
      }
      throw this.handleConfigError(error, "workspace.yml");
    }
  }

  /**
   * Load job specifications from workspace config and files
   */
  private async loadJobSpecs(
    workspaceConfig: WorkspaceConfig,
  ): Promise<Record<string, JobSpecification>> {
    const jobs: Record<string, JobSpecification> = {};

    // Load inline jobs from workspace config
    if (workspaceConfig.jobs) {
      for (const [jobName, jobSpec] of Object.entries(workspaceConfig.jobs)) {
        jobs[jobName] = this.normalizeJobSpec(jobName, jobSpec);
      }
    }

    // Load jobs from files
    const jobsDir = join(this.workspaceDir, "jobs");
    const jobFiles = await this.adapter.loadJobFiles(jobsDir);

    for (const [name, rawSpec] of jobFiles) {
      try {
        const spec = JobSpecificationSchema.parse(rawSpec);
        jobs[name] = this.normalizeJobSpec(name, spec);
      } catch (error) {
        if (error instanceof z.ZodError) {
          throw new ConfigValidationError(
            formatZodError(error, `jobs/${name}.yml`),
            `jobs/${name}.yml`,
          );
        }
        throw error;
      }
    }

    return jobs;
  }

  /**
   * Normalize a job specification
   */
  private normalizeJobSpec(
    name: string,
    spec: JobSpecification,
  ): JobSpecification {
    // Normalize string agents to objects
    const normalizedAgents = spec.execution.agents.map((agent) => {
      if (typeof agent === "string") {
        return { id: agent };
      }
      return agent;
    });

    return {
      ...spec,
      name: spec.name || name,
      description: spec.description || `Job: ${name}`,
      execution: {
        ...spec.execution,
        agents: normalizedAgents,
      },
    };
  }

  /**
   * Validate configuration cross-references
   */
  private validateConfig(
    atlasConfig: AtlasConfig,
    workspaceConfig: WorkspaceConfig,
    jobs: Record<string, JobSpecification>,
  ): void {
    // Validate MCP server references in agents
    for (
      const [agentId, agentConfig] of Object.entries(
        workspaceConfig.agents || {},
      )
    ) {
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
          const workspaceAgents = workspaceConfig.agents || {};
          const atlasAgents = atlasConfig.agents || {};

          if (!workspaceAgents[agentId] && !atlasAgents[agentId]) {
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
      if (jobSpec.triggers) {
        for (const trigger of jobSpec.triggers) {
          const signalId = trigger.signal;
          if (!workspaceConfig.signals || !workspaceConfig.signals[signalId]) {
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
  }

  /**
   * Handle configuration errors
   */
  private handleConfigError(error: unknown, filename: string): never {
    if (error instanceof z.ZodError) {
      throw new ConfigValidationError(
        formatZodError(error, filename),
        filename,
      );
    }
    throw new ConfigValidationError(
      `Failed to load ${filename}: ${error instanceof Error ? error.message : String(error)}`,
      filename,
    );
  }

  /**
   * Create default atlas configuration
   */
  private async createDefaultAtlasConfig(): Promise<AtlasConfig> {
    // Import atlas defaults
    const { atlasDefaults } = await import("./defaults/atlas-defaults.ts");

    // Validate the default config against the schema
    return AtlasConfigSchema.parse(atlasDefaults);
  }

  /**
   * Merge supervisor defaults with atlas config
   * Atlas config supervisors override defaults
   */
  private mergeSupervisorDefaults(
    atlasConfig: AtlasConfig,
    supervisorDefaults: SupervisorDefaults,
  ): AtlasConfig {
    // If atlas config already has supervisors, use them as-is
    if (atlasConfig.supervisors) {
      return atlasConfig;
    }

    // Otherwise, use defaults
    return {
      ...atlasConfig,
      supervisors: supervisorDefaults.supervisors || {
        workspace: {
          model: "claude-3-5-sonnet-20241022",
          prompts: { system: "You are a WorkspaceSupervisor." },
        },
        session: {
          model: "claude-3-5-sonnet-20241022",
          prompts: { system: "You are a SessionSupervisor." },
        },
        agent: {
          model: "claude-3-5-sonnet-20241022",
          prompts: { system: "You are an AgentSupervisor." },
        },
      },
    };
  }

  /**
   * Convert workspace agent config to SessionSupervisor agent config
   */
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
        throw new Error(
          `Unknown agent type: ${workspaceAgentConfig.type}`,
        );
    }
  }
}
