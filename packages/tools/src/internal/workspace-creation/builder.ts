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

  validateWorkspace(): ValidationResult {
    if (!this.identity) {
      return { success: false, errors: ["Workspace identity not initialized"], warnings: [] };
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
          client_config: { timeout: "30s" },
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
