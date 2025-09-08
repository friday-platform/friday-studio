import { AtlasAgentConfigSchema } from "@atlas/agent-sdk";
import {
  type JobSpecification,
  LLMAgentConfigSchema,
  type MCPServerConfig,
  type WorkspaceConfig,
  type WorkspaceSignalConfig,
} from "@atlas/config";
import z from "zod/v4";

export interface ValidationResult {
  success: boolean;
  errors: string[];
  warnings: string[];
  suggestions?: string[];
}

export interface WorkspaceSummary {
  signalCount: number;
  signalTypes: string[];
  signalIds: string[];
  agentCount: number;
  agentTypes: string[];
  agentIds: string[];
  jobCount: number;
  jobIds: string[];
  mcpServerCount: number;
  mcpServerIds: string[];
}

export const AgentConfigSchema = z.discriminatedUnion("type", [
  LLMAgentConfigSchema,
  AtlasAgentConfigSchema,
]);

export type AgentConfig = z.infer<typeof AgentConfigSchema>;

/**
 * Builds workspace configurations by accumulating components.
 */
export class WorkspaceBuilder {
  private name?: string;
  private description?: string;
  private signals = new Map<string, WorkspaceSignalConfig>();
  private agents = new Map<string, AgentConfig>();
  private jobs = new Map<string, JobSpecification>();
  private mcpServers = new Map<string, MCPServerConfig>();
  private _mcpDomainRequirements = new Set<string>();

  /** Clears all workspace components. */
  reset(): void {
    this.name = undefined;
    this.description = undefined;
    this.signals.clear();
    this.agents.clear();
    this.jobs.clear();
    this.mcpServers.clear();
  }

  /** Adds MCP tool domain requirements for later server matching. */
  addMCPDomainRequirements(domains: string[]): void {
    for (const domain of domains) {
      this._mcpDomainRequirements.add(domain);
    }
  }

  get mcpDomainRequirements(): string[] {
    return [...this._mcpDomainRequirements];
  }

  /** Sets workspace name and description. */
  setIdentity(name: string, description: string): void {
    this.name = name;
    this.description = description;
  }

  /** Adds trigger signals to the workspace. */
  addSignals(signals: Array<{ id: string; config: WorkspaceSignalConfig }>): void {
    for (const { id, config } of signals) {
      this.signals.set(id, config);
    }
  }

  /** Adds AI agents to the workspace. */
  addAgents(agents: Array<{ id: string; config: AgentConfig }>): void {
    for (const { id, config } of agents) {
      this.agents.set(id, config);
    }
  }

  /** Adds jobs that connect signals to agents. */
  addJobs(jobs: Array<{ id: string; spec: JobSpecification }>): void {
    for (const { id, spec } of jobs) {
      this.jobs.set(id, spec);
    }
  }

  /** Adds MCP servers for agent tool access. */
  addMCPServers(servers: Array<{ id: string; config: MCPServerConfig }>): void {
    for (const { id, config } of servers) {
      this.mcpServers.set(id, config);
    }
  }

  /** Removes a job from the workspace. */
  removeJob(id: string): void {
    this.jobs.delete(id);
  }

  /** Returns all agent IDs in the workspace. */
  getAgentIds(): string[] {
    return Array.from(this.agents.keys());
  }

  /** Returns all signal IDs in the workspace. */
  getSignalIds(): string[] {
    return Array.from(this.signals.keys());
  }

  /** Returns workspace statistics and component counts. */
  getSummary(): WorkspaceSummary {
    const signalTypes = new Set<string>();
    for (const signal of this.signals.values()) {
      signalTypes.add(signal.provider);
    }

    const agentTypes = new Set<string>();
    for (const agent of this.agents.values()) {
      agentTypes.add(agent.type);
    }

    return {
      signalCount: this.signals.size,
      signalTypes: Array.from(signalTypes),
      signalIds: Array.from(this.signals.keys()),
      agentCount: this.agents.size,
      agentTypes: Array.from(agentTypes),
      agentIds: Array.from(this.agents.keys()),
      jobCount: this.jobs.size,
      jobIds: Array.from(this.jobs.keys()),
      mcpServerCount: this.mcpServers.size,
      mcpServerIds: Array.from(this.mcpServers.keys()),
    };
  }

  /** Validates workspace configuration and returns errors/warnings. */
  validateWorkspace(): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];
    const suggestions: string[] = [];

    if (!this.name) {
      errors.push("Workspace name is required");
    }
    if (!this.description) {
      warnings.push("Workspace description is missing");
    }

    if (this.signals.size === 0) {
      errors.push("At least one signal is required");
    }
    if (this.agents.size === 0) {
      errors.push("At least one agent is required");
    }
    if (this.jobs.size === 0) {
      errors.push("At least one job is required");
    }

    for (const [jobId, job] of this.jobs.entries()) {
      if (job.triggers) {
        for (const trigger of job.triggers) {
          if (!this.signals.has(trigger.signal)) {
            errors.push(`Job '${jobId}' references non-existent signal '${trigger.signal}'`);
          }
        }
      }

      if (job.execution?.agents) {
        for (const agent of job.execution.agents) {
          const agentId = typeof agent === "string" ? agent : agent.id;
          if (!this.agents.has(agentId)) {
            errors.push(`Job '${jobId}' references non-existent agent '${agentId}'`);
          }
        }
      }
    }

    const usedSignals = new Set<string>();
    const usedAgents = new Set<string>();
    for (const job of this.jobs.values()) {
      if (job.triggers) {
        for (const trigger of job.triggers) {
          usedSignals.add(trigger.signal);
        }
      }
      if (job.execution?.agents) {
        for (const agent of job.execution.agents) {
          const agentId = typeof agent === "string" ? agent : agent.id;
          usedAgents.add(agentId);
        }
      }
    }

    for (const signalId of this.signals.keys()) {
      if (!usedSignals.has(signalId)) {
        warnings.push(`Signal '${signalId}' is not used by any job`);
      }
    }

    for (const agentId of this.agents.keys()) {
      if (!usedAgents.has(agentId)) {
        warnings.push(`Agent '${agentId}' is not used by any job`);
      }
    }

    return { success: errors.length === 0, errors, warnings, suggestions };
  }

  /** Exports the final workspace configuration. */
  exportConfig(): WorkspaceConfig {
    if (!this.name) {
      throw new Error("Cannot export config without workspace name");
    }

    const config: WorkspaceConfig = {
      version: "1.0",
      workspace: { name: this.name, description: this.description || "" },
    };

    if (this.signals.size > 0) {
      config.signals = Object.fromEntries(this.signals.entries());
    }

    if (this.agents.size > 0) {
      config.agents = Object.fromEntries(this.agents.entries());
    }

    if (this.jobs.size > 0) {
      config.jobs = Object.fromEntries(this.jobs.entries());
    }

    if (this.mcpServers.size > 0) {
      config.tools = {
        mcp: {
          client_config: { timeout: { progressTimeout: "30s", maxTotalTimeout: "300s" } },
          servers: Object.fromEntries(this.mcpServers.entries()),
        },
      };
    }

    return config;
  }
}
