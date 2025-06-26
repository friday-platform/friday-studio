/**
 * Configuration loader for Atlas that merges atlas.yml and workspace.yml
 */

import { join } from "@std/path";
import { parse as parseYaml } from "@std/yaml";
import { z } from "zod/v4";
import { logger } from "../utils/logger.ts";
import type { IConfigurationAdapter } from "../../packages/storage/mod.ts";
import type {
  AgentConfig,
  JobSpecification as SessionJobSpecification,
  LLMAgentConfig,
  RemoteAgentConfig,
  TempestAgentConfig,
} from "./session-supervisor.ts";

// Import all configuration types and schemas from @atlas/types
import {
  AtlasConfig,
  AtlasConfigSchema,
  ConfigValidationError,
  getAgentSupervisorConfig,
  JobSpecification,
  JobSpecificationSchema,
  MergedConfig,
  SupervisorDefaults,
  SupervisorDefaultsSchema,
  SupervisorsConfig,
  SupervisorsConfigSchema,
  WorkspaceAgentConfig,
  WorkspaceAgentConfigSchema,
  WorkspaceConfig,
  WorkspaceConfigSchema,
  WorkspaceMCPServerConfig,
  WorkspaceMCPServerConfigSchema,
  WorkspaceSignalConfig,
  WorkspaceSignalConfigSchema,
} from "@atlas/types";

// Re-export types that are still used externally
export type {
  AtlasConfig,
  JobSpecification,
  MergedConfig,
  SupervisorDefaults,
  SupervisorsConfig,
  WorkspaceAgentConfig,
  WorkspaceConfig,
  WorkspaceMCPServerConfig,
  WorkspaceSignalConfig,
};

// Re-export non-type exports
export {
  AtlasConfigSchema,
  ConfigValidationError,
  getAgentSupervisorConfig,
  JobSpecificationSchema,
  SupervisorDefaultsSchema,
  SupervisorsConfigSchema,
  WorkspaceAgentConfigSchema,
  WorkspaceConfigSchema,
  WorkspaceMCPServerConfigSchema,
  WorkspaceSignalConfigSchema,
};

export class ConfigLoader {
  private adapter: IConfigurationAdapter;
  private workspaceDir: string;

  constructor(adapter: IConfigurationAdapter, workspaceDir: string = ".") {
    this.adapter = adapter;
    this.workspaceDir = workspaceDir;
  }

  async load(): Promise<MergedConfig> {
    // Load supervisor defaults first
    const supervisorDefaults = await this.adapter.loadSupervisorDefaults();

    // Load atlas.yml - platform configuration
    const atlasConfig = await this.adapter.loadAtlasConfig();

    // Merge supervisor defaults with atlas config
    const mergedAtlasConfig = this.mergeSupervisorDefaults(atlasConfig, supervisorDefaults);

    // Load workspace.yml - user configuration
    const workspaceConfig = await this.adapter.loadWorkspaceConfig();

    // Load job specifications from files
    const jobsFromFiles = await this.adapter.loadJobSpecs();

    // Combine jobs from workspace config and files
    const jobs = this.combineJobs(workspaceConfig, jobsFromFiles);

    // Validate merged configuration
    this.validateConfig(mergedAtlasConfig, workspaceConfig, jobs);

    return {
      atlas: mergedAtlasConfig,
      workspace: workspaceConfig,
      jobs,
      supervisorDefaults, // Include supervisor defaults for workers
    };
  }

  /**
   * Combine jobs from workspace config and job files
   */
  private combineJobs(
    workspaceConfig: WorkspaceConfig,
    jobsFromFiles: Record<string, JobSpecification>,
  ): Record<string, JobSpecification> {
    const jobs: Record<string, JobSpecification> = {};

    // Load jobs from top-level jobs section in workspace config
    if (workspaceConfig.jobs) {
      for (const [jobName, jobSpec] of Object.entries(workspaceConfig.jobs)) {
        jobs[jobName] = jobSpec;
      }
    }

    // Merge jobs from files (they can override workspace config jobs)
    Object.assign(jobs, jobsFromFiles);

    return jobs;
  }

  /**
   * Convert JobSpecification from @atlas/types to SessionJobSpecification
   * This handles the normalization of string agents to JobAgentSpec objects
   */
  public convertToSessionJobSpec(jobSpec: JobSpecification): SessionJobSpecification {
    // Normalize string agents to JobAgentSpec objects
    const normalizedAgents = jobSpec.execution.agents.map((agent) => {
      if (typeof agent === "string") {
        return { id: agent };
      }
      // Convert the agent spec to match SessionJobSpecification's JobAgentSpec
      return {
        id: agent.id,
        prompt: agent.task, // Map 'task' to 'prompt'
        input_source: agent.input_source,
        // Note: The @atlas/types schema doesn't include mode, config, or input
        // These will be undefined unless added to the schema
      };
    });

    return {
      name: jobSpec.name,
      description: jobSpec.description,
      task_template: jobSpec.task_template,
      triggers: jobSpec.triggers,
      session_prompts: jobSpec.session_prompts,
      execution: {
        strategy: jobSpec.execution.strategy,
        agents: normalizedAgents,
        context: jobSpec.execution.context,
      },
      success_criteria: jobSpec.success_criteria,
      error_handling: jobSpec.error_handling,
      resources: jobSpec.resources,
    };
  }

  private validateConfig(
    atlasConfig: AtlasConfig,
    workspaceConfig: WorkspaceConfig,
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

  /**
   * Merge supervisor defaults with atlas config
   * Atlas config supervisors override defaults
   */
  private mergeSupervisorDefaults(
    atlasConfig: AtlasConfig,
    supervisorDefaults: import("@atlas/types").SupervisorDefaults,
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
}
