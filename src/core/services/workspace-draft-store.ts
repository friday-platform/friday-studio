import type { WorkspaceConfig } from "@atlas/config";

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
    initialConfig?: Partial<WorkspaceConfig>; // NEW: Accept initial config
  }): Promise<WorkspaceDraft> {
    // Start with minimal base config
    const baseConfig: Partial<WorkspaceConfig> = {
      version: "1.0",
      workspace: {
        name: params.name,
        description: params.description,
      },
    };

    // Merge with provided initial config if any
    const config = params.initialConfig
      ? this.deepMerge(baseConfig, params.initialConfig)
      : baseConfig;

    const draft: WorkspaceDraft = {
      id: crypto.randomUUID(),
      name: params.name,
      description: params.description,
      config,
      iterations: params.initialConfig
        ? [{
          timestamp: new Date().toISOString(),
          operation: "initial_config",
          config: params.initialConfig,
          summary: "Created with initial configuration",
        }]
        : [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: "draft",
      sessionId: params.sessionId,
      userId: params.userId,
    };

    const key = ["workspace_drafts", draft.id];
    await this.kv.set(key, draft);

    // Index by session
    const sessionKey = ["workspace_drafts_by_session", params.sessionId, draft.id];
    await this.kv.set(sessionKey, draft.id);

    return draft;
  }

  async updateDraft(
    draftId: string,
    updates: Partial<WorkspaceConfig>,
    updateDescription: string,
  ): Promise<WorkspaceDraft> {
    const key = ["workspace_drafts", draftId];
    const entry = await this.kv.get<WorkspaceDraft>(key);

    if (!entry.value) {
      throw new Error(`Draft ${draftId} not found`);
    }

    const draft = entry.value;

    // Deep merge the updates into existing config
    draft.config = this.deepMerge(draft.config, updates);

    // Add to iteration history
    draft.iterations.push({
      timestamp: new Date().toISOString(),
      operation: "update_config",
      config: updates,
      summary: updateDescription,
    });

    draft.updatedAt = new Date().toISOString();
    await this.kv.set(key, draft);
    return draft;
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

  private deepMerge(
    target: Partial<WorkspaceConfig>,
    source: Partial<WorkspaceConfig>,
  ): Partial<WorkspaceConfig> {
    const result: Record<string, unknown> = { ...target };

    for (const key in source) {
      const sourceValue = source[key as keyof WorkspaceConfig];
      const targetValue = target[key as keyof WorkspaceConfig];

      if (
        sourceValue &&
        typeof sourceValue === "object" &&
        !Array.isArray(sourceValue) &&
        targetValue &&
        typeof targetValue === "object" &&
        !Array.isArray(targetValue)
      ) {
        // Recursively merge objects
        result[key] = {
          ...targetValue,
          ...sourceValue,
        };
      } else {
        // Direct assignment for primitives and arrays
        result[key] = sourceValue;
      }
    }

    return result as Partial<WorkspaceConfig>;
  }
}
