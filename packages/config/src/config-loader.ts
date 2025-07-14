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
// Agent config types are now part of WorkspaceAgentConfig in schemas.ts
// These type aliases are for backward compatibility
type AgentConfig = WorkspaceAgentConfig;
type LLMAgentConfig = WorkspaceAgentConfig & { type: "llm" };
type RemoteAgentConfig = WorkspaceAgentConfig & { type: "remote" };
type TempestAgentConfig = WorkspaceAgentConfig & { type: "tempest" };

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
   * Load atlas.yml configuration (public method)
   */
  async loadAtlasConfig(): Promise<AtlasConfig> {
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
    // Validate MCP server configuration if enabled
    this.validateMCPConfiguration(workspaceConfig, jobs);

    // Validate MCP server references in agents
    for (
      const [agentId, agentConfig] of Object.entries(
        workspaceConfig.agents || {},
      )
    ) {
      // Check for new format MCP configuration: tools.mcp
      if (
        agentConfig.tools && typeof agentConfig.tools === "object" &&
        !Array.isArray(agentConfig.tools)
      ) {
        const toolsConfig = agentConfig.tools as { mcp?: string[] };
        if (toolsConfig.mcp && Array.isArray(toolsConfig.mcp) && toolsConfig.mcp.length > 0) {
          // Ensure agent is LLM type if using MCP servers
          if (agentConfig.type !== "llm") {
            throw new ConfigValidationError(
              `Agent '${agentId}' has tools.mcp configured but is not an LLM agent. Only LLM agents support MCP servers.`,
              "workspace.yml",
              `agents.${agentId}.tools.mcp`,
              toolsConfig.mcp,
            );
          }

          // Validate each MCP server reference exists
          for (const mcpServerId of toolsConfig.mcp) {
            if (!workspaceConfig.tools?.mcp?.servers?.[mcpServerId]) {
              throw new ConfigValidationError(
                `Agent '${agentId}' references MCP server '${mcpServerId}' which is not defined in tools.mcp.servers section`,
                "workspace.yml",
                `agents.${agentId}.tools.mcp`,
                mcpServerId,
              );
            }
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
   * Validate MCP server configuration to prevent invalid workspaces from registering
   */
  private validateMCPConfiguration(
    workspaceConfig: WorkspaceConfig,
    jobs: Record<string, JobSpecification>,
  ): void {
    const serverConfig = workspaceConfig.server?.mcp;
    if (!serverConfig?.enabled) {
      return; // MCP not enabled, skip validation
    }

    // Validate discoverable job patterns match actual jobs
    if (serverConfig.discoverable?.jobs) {
      for (const jobPattern of serverConfig.discoverable.jobs) {
        const isWildcard = jobPattern.endsWith("*");
        const basePattern = isWildcard ? jobPattern.slice(0, -1) : jobPattern;

        // Find matching jobs
        const matchingJobs = Object.keys(jobs).filter((jobName) => {
          return isWildcard ? jobName.startsWith(basePattern) : jobName === jobPattern;
        });

        if (matchingJobs.length === 0) {
          throw new ConfigValidationError(
            `MCP discoverable job pattern '${jobPattern}' doesn't match any defined jobs. Available jobs: ${
              Object.keys(jobs).join(", ")
            }`,
            "workspace.yml",
            "server.mcp.discoverable.jobs",
            jobPattern,
          );
        }

        // Validate that matching jobs have MCP-compliant names (already validated by schema, but explicit check)
        for (const jobName of matchingJobs) {
          if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(jobName)) {
            throw new ConfigValidationError(
              `Job '${jobName}' matched by MCP discoverable pattern '${jobPattern}' has invalid MCP tool name. MCP tool names must start with a letter and contain only letters, numbers, underscores, and hyphens.`,
              "workspace.yml",
              "jobs",
              jobName,
            );
          }
        }
      }
    }

    // Validate capability patterns refer to valid workspace capabilities
    if (serverConfig.discoverable?.capabilities) {
      const validWorkspaceCapabilities = [
        "workspace_jobs_list",
        "workspace_jobs_trigger",
        "workspace_jobs_describe",
        "workspace_sessions_list",
        "workspace_sessions_describe",
        "workspace_sessions_cancel",
        "workspace_agents_list",
        "workspace_agents_describe",
        "workspace_signals_list",
        "workspace_signals_trigger",
      ];

      for (const capabilityPattern of serverConfig.discoverable.capabilities) {
        const isWildcard = capabilityPattern.endsWith("*");
        const basePattern = isWildcard ? capabilityPattern.slice(0, -1) : capabilityPattern;

        // Find matching capabilities
        const matchingCapabilities = validWorkspaceCapabilities.filter((cap) => {
          return isWildcard ? cap.startsWith(basePattern) : cap === capabilityPattern;
        });

        if (matchingCapabilities.length === 0) {
          throw new ConfigValidationError(
            `MCP discoverable capability pattern '${capabilityPattern}' doesn't match any valid workspace capabilities. Valid capabilities: ${
              validWorkspaceCapabilities.join(", ")
            }`,
            "workspace.yml",
            "server.mcp.discoverable.capabilities",
            capabilityPattern,
          );
        }
      }
    }

    // Validate rate limits are reasonable
    if (serverConfig.rate_limits) {
      if (
        serverConfig.rate_limits.requests_per_hour &&
        serverConfig.rate_limits.requests_per_hour > 10000
      ) {
        throw new ConfigValidationError(
          `MCP rate limit requests_per_hour (${serverConfig.rate_limits.requests_per_hour}) is too high. Maximum allowed: 10000`,
          "workspace.yml",
          "server.mcp.rate_limits.requests_per_hour",
          serverConfig.rate_limits.requests_per_hour,
        );
      }

      if (
        serverConfig.rate_limits.concurrent_sessions &&
        serverConfig.rate_limits.concurrent_sessions > 100
      ) {
        throw new ConfigValidationError(
          `MCP rate limit concurrent_sessions (${serverConfig.rate_limits.concurrent_sessions}) is too high. Maximum allowed: 100`,
          "workspace.yml",
          "server.mcp.rate_limits.concurrent_sessions",
          serverConfig.rate_limits.concurrent_sessions,
        );
      }
    }

    logger.info("MCP configuration validation passed", {
      workspaceId: workspaceConfig.workspace.id || workspaceConfig.workspace.name,
      mcpEnabled: serverConfig.enabled,
      discoverableJobs: serverConfig.discoverable?.jobs?.length || 0,
      discoverableCapabilities: serverConfig.discoverable?.capabilities?.length || 0,
      hasRateLimits: !!serverConfig.rate_limits,
    });
  }

  /**
   * Convert workspace agent config to SessionSupervisor agent config
   */
  convertToAgentConfig(
    workspaceAgentConfig: WorkspaceAgentConfig,
  ): AgentConfig {
    return ConfigLoader.convertWorkspaceAgentConfig(workspaceAgentConfig);
  }

  /**
   * Static version of convertToAgentConfig for use without ConfigLoader instance
   */
  static convertWorkspaceAgentConfig(
    workspaceAgentConfig: WorkspaceAgentConfig,
  ): AgentConfig {
    switch (workspaceAgentConfig.type) {
      case "system":
        return {
          type: "system",
          agent: workspaceAgentConfig.agent!,
          version: workspaceAgentConfig.version!,
          config: workspaceAgentConfig.config,
          tools: workspaceAgentConfig.tools,
        } as TempestAgentConfig;

      case "llm": {
        return {
          type: "llm",
          model: workspaceAgentConfig.model!,
          purpose: workspaceAgentConfig.purpose,
          tools: workspaceAgentConfig.tools,
          prompts: workspaceAgentConfig.prompts,
          max_steps: workspaceAgentConfig.max_steps,
          tool_choice: workspaceAgentConfig.tool_choice,
        } as LLMAgentConfig;
      }

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
