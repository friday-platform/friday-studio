import {
  type JobSpecification,
  JobSpecificationSchema,
  type MCPServerConfig,
  MCPServerConfigSchema,
  type WorkspaceAgentConfig,
  WorkspaceAgentConfigSchema,
  type WorkspaceConfig,
  WorkspaceConfigSchema,
  type WorkspaceSignalConfig,
  WorkspaceSignalConfigSchema,
} from "@atlas/config";

interface ValidationResult {
  success: boolean;
  errors: string[];
  warnings: string[];
}

interface RepairResult {
  success: boolean;
  repairs: string[];
  errors: string[];
}

interface WorkspaceIdentity {
  name: string;
  description: string;
}

export class WorkspaceBuilder {
  // Use Maps for clean internal state management - no bang operators needed
  private identity?: WorkspaceIdentity;
  private signals = new Map<string, WorkspaceSignalConfig>();
  private jobs = new Map<string, JobSpecification>();
  private agents = new Map<string, WorkspaceAgentConfig>();
  private mcpServers = new Map<string, MCPServerConfig>();

  constructor(existingConfig?: WorkspaceConfig) {
    if (existingConfig) {
      this.populateFromExisting(existingConfig);
    }
  }

  private populateFromExisting(config: WorkspaceConfig): void {
    // Set workspace identity
    this.identity = {
      name: config.workspace.name,
      description: config.workspace.description || "",
    };

    // Load signals
    this.loadSignals(config.signals || {});

    // Load agents
    this.loadAgents(config.agents || {});

    // Load jobs
    this.loadJobs(config.jobs || {});

    // Load MCP servers
    this.loadMcpServers(config.tools?.mcp?.servers || {});
  }

  private loadSignals(signals: Record<string, WorkspaceSignalConfig>): void {
    Object.entries(signals).forEach(([name, config]) => {
      this.signals.set(name, config);
    });
  }

  private loadAgents(agents: Record<string, WorkspaceAgentConfig>): void {
    Object.entries(agents).forEach(([id, config]) => {
      this.agents.set(id, config);
    });
  }

  private loadJobs(jobs: Record<string, JobSpecification>): void {
    Object.entries(jobs).forEach(([name, config]) => {
      this.jobs.set(name, config);
    });
  }

  private loadMcpServers(servers: Record<string, MCPServerConfig>): void {
    Object.entries(servers).forEach(([name, config]) => {
      this.mcpServers.set(name, config);
    });
  }

  initialize(identity: WorkspaceIdentity): ValidationResult {
    // TypeScript ensures identity has correct structure
    this.identity = identity;
    return { success: true, errors: [], warnings: [] };
  }

  addSignal(name: string, config: WorkspaceSignalConfig): ValidationResult {
    if (this.signals.has(name)) {
      return { success: false, errors: [`Signal '${name}' already exists`], warnings: [] };
    }

    // Runtime validation via authoritative config schema
    const signalResult = WorkspaceSignalConfigSchema.safeParse(config);
    if (!signalResult.success) {
      return {
        success: false,
        errors: signalResult.error.issues.map((e) => `Signal validation: ${e.message}`),
        warnings: [],
      };
    }

    this.signals.set(name, signalResult.data);
    return { success: true, errors: [], warnings: [] };
  }

  addAgent(id: string, config: WorkspaceAgentConfig): ValidationResult {
    if (this.agents.has(id)) {
      return { success: false, errors: [`Agent '${id}' already exists`], warnings: [] };
    }

    const agentResult = WorkspaceAgentConfigSchema.safeParse(config);
    if (!agentResult.success) {
      return {
        success: false,
        errors: agentResult.error.issues.map((e) => `Agent validation: ${e.message}`),
        warnings: [],
      };
    }

    this.agents.set(id, agentResult.data);
    return { success: true, errors: [], warnings: [] };
  }

  addJob(name: string, config: JobSpecification): ValidationResult {
    if (this.jobs.has(name)) {
      return { success: false, errors: [`Job '${name}' already exists`], warnings: [] };
    }

    const jobResult = JobSpecificationSchema.safeParse(config);
    if (!jobResult.success) {
      return {
        success: false,
        errors: jobResult.error.issues.map((e) => `Job validation: ${e.message}`),
        warnings: [],
      };
    }

    // Validate signal references using clean Map API
    for (const trigger of jobResult.data.triggers || []) {
      if (!this.signals.has(trigger.signal)) {
        return {
          success: false,
          errors: [`Job '${name}' references undefined signal '${trigger.signal}'`],
          warnings: [],
        };
      }
    }

    // Validate agent references
    for (const agent of jobResult.data.execution?.agents || []) {
      const agentId = typeof agent === "string" ? agent : agent.id;
      if (!this.agents.has(agentId)) {
        return {
          success: false,
          errors: [`Job '${name}' references undefined agent '${agentId}'`],
          warnings: [],
        };
      }
    }

    this.jobs.set(name, jobResult.data);
    return { success: true, errors: [], warnings: [] };
  }

  addMCPIntegration(serverName: string, config: MCPServerConfig): ValidationResult {
    if (this.mcpServers.has(serverName)) {
      return {
        success: false,
        errors: [`MCP server '${serverName}' already exists`],
        warnings: [],
      };
    }

    const mcpResult = MCPServerConfigSchema.safeParse(config);
    if (!mcpResult.success) {
      return {
        success: false,
        errors: mcpResult.error.issues.map((e) => `MCP validation: ${e.message}`),
        warnings: [],
      };
    }

    this.mcpServers.set(serverName, mcpResult.data);
    return { success: true, errors: [], warnings: [] };
  }

  updateSignal(id: string, updates: Partial<WorkspaceSignalConfig>): ValidationResult {
    if (!this.signals.has(id)) {
      return { success: false, errors: [`Signal '${id}' does not exist`], warnings: [] };
    }

    const existingSignal = this.signals.get(id)!;
    const updatedSignal = { ...existingSignal, ...updates };

    const signalResult = WorkspaceSignalConfigSchema.safeParse(updatedSignal);
    if (!signalResult.success) {
      return {
        success: false,
        errors: signalResult.error.issues.map((e) => `Signal validation: ${e.message}`),
        warnings: [],
      };
    }

    this.signals.set(id, signalResult.data);
    return { success: true, errors: [], warnings: [] };
  }

  updateAgent(id: string, updates: Partial<WorkspaceAgentConfig>): ValidationResult {
    if (!this.agents.has(id)) {
      return { success: false, errors: [`Agent '${id}' does not exist`], warnings: [] };
    }

    const existingAgent = this.agents.get(id)!;
    const updatedAgent = { ...existingAgent, ...updates };

    const agentResult = WorkspaceAgentConfigSchema.safeParse(updatedAgent);
    if (!agentResult.success) {
      return {
        success: false,
        errors: agentResult.error.issues.map((e) => `Agent validation: ${e.message}`),
        warnings: [],
      };
    }

    this.agents.set(id, agentResult.data);
    return { success: true, errors: [], warnings: [] };
  }

  updateJob(name: string, updates: Partial<JobSpecification>): ValidationResult {
    if (!this.jobs.has(name)) {
      return { success: false, errors: [`Job '${name}' does not exist`], warnings: [] };
    }

    const existingJob = this.jobs.get(name)!;
    const updatedJob = { ...existingJob, ...updates };

    const jobResult = JobSpecificationSchema.safeParse(updatedJob);
    if (!jobResult.success) {
      return {
        success: false,
        errors: jobResult.error.issues.map((e) => `Job validation: ${e.message}`),
        warnings: [],
      };
    }

    // Validate signal references using clean Map API
    for (const trigger of jobResult.data.triggers || []) {
      if (!this.signals.has(trigger.signal)) {
        return {
          success: false,
          errors: [`Job '${name}' references undefined signal '${trigger.signal}'`],
          warnings: [],
        };
      }
    }

    // Validate agent references
    for (const agent of jobResult.data.execution?.agents || []) {
      const agentId = typeof agent === "string" ? agent : agent.id;
      if (!this.agents.has(agentId)) {
        return {
          success: false,
          errors: [`Job '${name}' references undefined agent '${agentId}'`],
          warnings: [],
        };
      }
    }

    this.jobs.set(name, jobResult.data);
    return { success: true, errors: [], warnings: [] };
  }

  removeSignal(id: string): ValidationResult {
    if (!this.signals.has(id)) {
      return { success: false, errors: [`Signal '${id}' does not exist`], warnings: [] };
    }

    // Check for dependent jobs
    const dependentJobs = Array.from(this.jobs.entries()).filter(([, job]) =>
      job.triggers?.some((trigger) => trigger.signal === id)
    );

    if (dependentJobs.length > 0) {
      const jobNames = dependentJobs.map(([name]) => name).join(", ");
      return {
        success: false,
        errors: [`Cannot remove signal '${id}': referenced by jobs: ${jobNames}`],
        warnings: [],
      };
    }

    this.signals.delete(id);
    return { success: true, errors: [], warnings: [] };
  }

  removeAgent(id: string): ValidationResult {
    if (!this.agents.has(id)) {
      return { success: false, errors: [`Agent '${id}' does not exist`], warnings: [] };
    }

    // Check for dependent jobs
    const dependentJobs = Array.from(this.jobs.entries()).filter(([, job]) =>
      job.execution?.agents?.some((agent) => {
        const agentId = typeof agent === "string" ? agent : agent.id;
        return agentId === id;
      })
    );

    if (dependentJobs.length > 0) {
      const jobNames = dependentJobs.map(([name]) => name).join(", ");
      return {
        success: false,
        errors: [`Cannot remove agent '${id}': referenced by jobs: ${jobNames}`],
        warnings: [],
      };
    }

    this.agents.delete(id);
    return { success: true, errors: [], warnings: [] };
  }

  removeJob(name: string): ValidationResult {
    if (!this.jobs.has(name)) {
      return { success: false, errors: [`Job '${name}' does not exist`], warnings: [] };
    }

    this.jobs.delete(name);
    return { success: true, errors: [], warnings: [] };
  }

  validateReferences(): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Check job signal references
    for (const [jobName, job] of this.jobs.entries()) {
      for (const trigger of job.triggers || []) {
        if (!this.signals.has(trigger.signal)) {
          errors.push(`Job '${jobName}' references undefined signal '${trigger.signal}'`);
        }
      }

      // Check job agent references
      for (const agent of job.execution?.agents || []) {
        const agentId = typeof agent === "string" ? agent : agent.id;
        if (!this.agents.has(agentId)) {
          errors.push(`Job '${jobName}' references undefined agent '${agentId}'`);
        }
      }
    }

    return {
      success: errors.length === 0,
      errors,
      warnings,
    };
  }

  repairBrokenReferences(): RepairResult {
    const repairs: string[] = [];
    const errors: string[] = [];

    // Find and repair broken references
    const jobsToProcess = Array.from(this.jobs.entries());
    for (const [jobName, job] of jobsToProcess) {
      let jobModified = false;
      let shouldRemoveJob = false;
      const updatedJob = { ...job };

      // Repair signal references
      if (updatedJob.triggers) {
        const validTriggers = updatedJob.triggers.filter((trigger) => {
          if (!this.signals.has(trigger.signal)) {
            repairs.push(
              `Removed broken signal reference '${trigger.signal}' from job '${jobName}'`,
            );
            jobModified = true;
            return false;
          }
          return true;
        });

        if (validTriggers.length === 0) {
          shouldRemoveJob = true;
          repairs.push(`Removed job '${jobName}' due to no valid triggers remaining`);
        } else if (jobModified) {
          updatedJob.triggers = validTriggers;
        }
      }

      // Repair agent references
      if (!shouldRemoveJob && updatedJob.execution?.agents) {
        const validAgents = updatedJob.execution.agents.filter((agent) => {
          const agentId = typeof agent === "string" ? agent : agent.id;
          if (!this.agents.has(agentId)) {
            repairs.push(`Removed broken agent reference '${agentId}' from job '${jobName}'`);
            jobModified = true;
            return false;
          }
          return true;
        });

        if (validAgents.length === 0) {
          shouldRemoveJob = true;
          repairs.push(`Removed job '${jobName}' due to no valid agents remaining`);
        } else if (jobModified) {
          updatedJob.execution = {
            ...updatedJob.execution,
            agents: validAgents,
          };
        }
      }

      // Remove job entirely if it has no valid references
      if (shouldRemoveJob) {
        this.jobs.delete(jobName);
      } else if (jobModified) {
        // Update job if it was modified and is still valid
        const jobResult = JobSpecificationSchema.safeParse(updatedJob);
        if (jobResult.success) {
          this.jobs.set(jobName, jobResult.data);
        } else {
          errors.push(
            `Failed to repair job '${jobName}': ${
              jobResult.error.issues.map((e) => e.message).join(", ")
            }`,
          );
        }
      }
    }

    return {
      success: errors.length === 0,
      repairs,
      errors,
    };
  }

  validateWorkspace(): ValidationResult {
    if (!this.identity) {
      return { success: false, errors: ["Workspace identity not initialized"], warnings: [] };
    }

    // First validate references
    const referenceResult = this.validateReferences();
    if (!referenceResult.success) {
      return referenceResult;
    }

    // Convert to final format and validate via authoritative schema
    const config = this.exportConfig();
    const configResult = WorkspaceConfigSchema.safeParse(config);

    if (!configResult.success) {
      return {
        success: false,
        errors: configResult.error.issues.map((e) =>
          `Schema validation: ${e.path.join(".")}: ${e.message}`
        ),
        warnings: [],
      };
    }

    return { success: true, errors: [], warnings: [] };
  }

  exportConfig(): WorkspaceConfig {
    if (!this.identity) {
      throw new Error("Cannot export configuration without workspace identity");
    }

    const config: WorkspaceConfig = {
      version: "1.0",
      workspace: this.identity,
      signals: Object.fromEntries(this.signals),
      jobs: Object.fromEntries(this.jobs),
      agents: Object.fromEntries(this.agents),
    };

    // Only add tools section if MCP servers exist
    if (this.mcpServers.size > 0) {
      config.tools = {
        mcp: {
          client_config: {
            timeout: {
              progressTimeout: "2m",
              maxTotalTimeout: "30m",
            },
          },
          servers: Object.fromEntries(this.mcpServers),
        },
      };
    }

    return config;
  }

  reset(): void {
    this.identity = undefined;
    this.signals.clear();
    this.jobs.clear();
    this.agents.clear();
    this.mcpServers.clear();
  }
}
