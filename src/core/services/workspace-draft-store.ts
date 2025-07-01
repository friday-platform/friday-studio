import type {
  JobSpecification,
  WorkspaceAgentConfig,
  WorkspaceConfig,
  WorkspaceMCPServerConfig,
  WorkspaceSignalConfig,
} from "@atlas/config";

export interface WorkspaceDraft {
  id: string;
  name: string;
  description: string;
  config: Partial<WorkspaceConfig>;
  iterations: Array<{
    timestamp: string;
    operation: string;
    config: Record<string, unknown>;
    summary: string;
  }>;
  createdAt: string;
  updatedAt: string;
  status: "draft" | "published" | "abandoned";
  sessionId: string;
  userId: string;
}

export class WorkspaceDraftStore {
  private kv: Deno.Kv;

  constructor(kv: Deno.Kv) {
    this.kv = kv;
  }

  async createDraft(params: {
    name: string;
    description: string;
    pattern?: string;
    sessionId: string;
    userId: string;
  }): Promise<WorkspaceDraft> {
    const draft: WorkspaceDraft = {
      id: crypto.randomUUID(),
      name: params.name,
      description: params.description,
      config: this.getInitialConfig(params.name, params.description, params.pattern),
      iterations: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: "draft",
      sessionId: params.sessionId,
      userId: params.userId,
    };

    const key = ["workspace_drafts", draft.id];
    await this.kv.set(key, draft);

    // Also index by session for easy retrieval
    const sessionKey = ["workspace_drafts_by_session", params.sessionId, draft.id];
    await this.kv.set(sessionKey, draft.id);

    return draft;
  }

  async updateDraft(
    draftId: string,
    operation: string,
    config: Record<string, unknown>,
  ): Promise<WorkspaceDraft> {
    const key = ["workspace_drafts", draftId];
    const entry = await this.kv.get<WorkspaceDraft>(key);

    if (!entry.value) {
      throw new Error(`Draft ${draftId} not found`);
    }

    const draft = entry.value;

    // Apply the update based on operation type
    this.applyOperation(draft, operation, config);

    // Add to iteration history
    draft.iterations.push({
      timestamp: new Date().toISOString(),
      operation,
      config,
      summary: this.generateOperationSummary(operation, config),
    });

    draft.updatedAt = new Date().toISOString();

    await this.kv.set(key, draft);
    return draft;
  }

  private applyOperation(
    draft: WorkspaceDraft,
    operation: string,
    config: Record<string, unknown>,
  ): void {
    switch (operation) {
      case "add_agent": {
        // Ensure agents object exists
        if (!draft.config.agents) draft.config.agents = {};

        // Handle both formats: id/purpose and name/description
        const agentId = (config.id || config.name) as string;
        const agentPurpose = (config.purpose || config.description) as string;

        // Map 'transformation' type to valid WorkspaceAgentConfig type
        let agentType = config.type as string;
        if (agentType === "transformation") {
          agentType = "llm"; // Default to LLM for transformation agents
        }

        // Create agent config using WorkspaceAgentConfig type
        const agentConfig: WorkspaceAgentConfig = {
          type: (agentType as "llm" | "tempest" | "remote") || "llm",
          model: config.model as string || "claude-3-5-haiku-20241022",
          purpose: agentPurpose,
          ...(config.system_prompt && { prompts: { system: config.system_prompt as string } }),
          ...(config.tools && { tools: { mcp: config.tools as string[] } }),
        };

        draft.config.agents[agentId] = agentConfig;
        break;
      }

      case "update_agent": {
        if (draft.config.agents && draft.config.agents[config.id as string]) {
          Object.assign(draft.config.agents[config.id as string], config.updates);
        }
        break;
      }

      case "add_job": {
        // Ensure jobs object exists
        if (!draft.config.jobs) draft.config.jobs = {};

        // Create job config using JobSpecification type
        const jobId = config.name as string || config.id as string;
        const jobConfig: JobSpecification = {
          name: jobId,
          description: config.description as string,
          triggers: config.triggers
            ? (Array.isArray(config.triggers) && typeof config.triggers[0] === "string"
              ? (config.triggers as string[]).map((t) => ({ signal: t }))
              : config.triggers as Array<{ signal: string }>)
            : [{ signal: `${draft.name}-trigger` }],
          execution: config.execution as JobSpecification["execution"],
        };

        draft.config.jobs[jobId] = jobConfig;
        break;
      }

      case "set_trigger": {
        // Ensure signals object exists
        if (!draft.config.signals) draft.config.signals = {};

        const signalId = `${draft.name}-trigger`;
        // Create signal config using WorkspaceSignalConfig type
        const signalConfig: WorkspaceSignalConfig = {
          description: config.description as string || `Trigger for ${draft.name}`,
          provider: config.provider as string,
          ...(config.providerConfig as Record<string, unknown>),
        };

        draft.config.signals[signalId] = signalConfig;
        break;
      }

      case "add_tool": {
        if (!draft.config.tools) draft.config.tools = {};
        if (!draft.config.tools.mcp) draft.config.tools.mcp = {};
        if (!draft.config.tools.mcp.servers) draft.config.tools.mcp.servers = {};
        draft.config.tools.mcp.servers[config.provider as string] = config
          .config as WorkspaceMCPServerConfig;
        break;
      }
    }
  }

  private getInitialConfig(
    name: string,
    description: string,
    pattern?: string,
  ): Partial<WorkspaceConfig> {
    // Return minimal config based on pattern using proper types
    const config: Partial<WorkspaceConfig> = {
      version: "1.0",
      workspace: {
        name,
        description: description || "",
      },
      signals: {},
      jobs: {},
      agents: {},
    };

    // Add pattern-specific defaults
    if (pattern === "pipeline") {
      config.signals![`${name}-trigger`] = {
        description: `Start the ${name} pipeline`,
        provider: "cli",
      };
    }

    return config;
  }

  async publishDraft(draftId: string): Promise<void> {
    const key = ["workspace_drafts", draftId];
    const entry = await this.kv.get<WorkspaceDraft>(key);

    if (!entry.value) {
      throw new Error(`Draft ${draftId} not found`);
    }

    const draft = entry.value;
    draft.status = "published";
    draft.updatedAt = new Date().toISOString();

    await this.kv.set(key, draft);
  }

  async getSessionDrafts(sessionId: string): Promise<WorkspaceDraft[]> {
    const drafts: WorkspaceDraft[] = [];
    const prefix = ["workspace_drafts_by_session", sessionId];

    for await (const entry of this.kv.list({ prefix })) {
      const draftId = entry.value as string;
      const draftEntry = await this.kv.get<WorkspaceDraft>(["workspace_drafts", draftId]);
      if (draftEntry.value && draftEntry.value.status === "draft") {
        drafts.push(draftEntry.value);
      }
    }

    return drafts;
  }

  async getDraft(draftId: string): Promise<WorkspaceDraft | null> {
    const key = ["workspace_drafts", draftId];
    const entry = await this.kv.get<WorkspaceDraft>(key);
    return entry.value;
  }

  private generateOperationSummary(operation: string, config: Record<string, unknown>): string {
    switch (operation) {
      case "add_agent": {
        // Handle both old format (id/purpose) and new format (name/description)
        const agentName = config.id || config.name || "unnamed";
        const agentPurpose = config.purpose || config.description || "unspecified";
        return `Added agent '${agentName}' with purpose: ${agentPurpose}`;
      }
      case "update_agent":
        return `Updated agent '${config.id || config.name}'`;
      case "add_job":
        return `Created job '${config.id || config.name}' to coordinate agents`;
      case "set_trigger":
        return `Configured ${config.provider} trigger for the workspace`;
      case "add_tool":
        return `Added ${config.provider} tool provider`;
      default:
        return `Applied ${operation} to workspace configuration`;
    }
  }
}
