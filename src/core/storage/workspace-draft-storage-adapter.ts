/**
 * Workspace Draft Storage Adapter
 *
 * Domain-specific storage adapter for workspace draft operations.
 * Built on top of the KVStorage interface to provide semantic draft operations
 * while maintaining complete storage backend independence.
 */

import { type KVStorage } from "./kv-storage.ts";
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

/**
 * Draft-specific storage operations
 *
 * This adapter provides high-level workspace draft operations built on
 * the foundational KVStorage interface. It handles draft lifecycle,
 * iterations, and workspace configuration building.
 */
export class WorkspaceDraftStorageAdapter {
  private readonly DRAFT_VERSION = "1.0.0";

  constructor(private storage: KVStorage) {}

  /**
   * Initialize the draft storage
   * Sets up initial metadata if not present
   */
  async initialize(): Promise<void> {
    await this.storage.initialize();

    // Initialize draft metadata if not exists
    const version = await this.storage.get<string>(["draft_metadata", "version"]);
    if (!version) {
      const atomic = this.storage.atomic();
      atomic.set(["draft_metadata", "version"], this.DRAFT_VERSION);
      atomic.set(["draft_metadata", "lastUpdated"], new Date().toISOString());
      await atomic.commit();
    }
  }

  /**
   * Create a new workspace draft
   */
  async createDraft(params: {
    name: string;
    description: string;
    pattern?: string;
    sessionId: string;
    userId: string;
    initialConfig?: Partial<WorkspaceConfig>;
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

    // Atomic operation to create draft and update indexes
    const atomic = this.storage.atomic();
    atomic.set(["workspace_drafts", draft.id], draft);
    atomic.set(["workspace_drafts_by_session", params.sessionId, draft.id], draft.id);
    atomic.set(["draft_metadata", "lastUpdated"], new Date().toISOString());

    const success = await atomic.commit();
    if (!success) {
      throw new Error("Failed to create draft - atomic operation failed");
    }

    return draft;
  }

  /**
   * Update a workspace draft with a new operation
   */
  async updateDraft(
    draftId: string,
    updates: Partial<WorkspaceConfig>,
    updateDescription: string,
  ): Promise<WorkspaceDraft> {
    const currentDraft = await this.getDraft(draftId);
    if (!currentDraft) {
      throw new Error(`Draft ${draftId} not found`);
    }

    // Create a deep copy for modification
    const updatedDraft: WorkspaceDraft = JSON.parse(JSON.stringify(currentDraft));

    // Deep merge the updates into existing config
    updatedDraft.config = this.deepMerge(updatedDraft.config, updates);

    // Add to iteration history
    updatedDraft.iterations.push({
      timestamp: new Date().toISOString(),
      operation: "update_config",
      config: updates,
      summary: updateDescription,
    });

    updatedDraft.updatedAt = new Date().toISOString();

    // Atomic update
    const atomic = this.storage.atomic();
    atomic.set(["workspace_drafts", draftId], updatedDraft);
    atomic.set(["draft_metadata", "lastUpdated"], new Date().toISOString());

    const success = await atomic.commit();
    if (!success) {
      throw new Error(`Failed to update draft ${draftId} - atomic operation failed`);
    }

    return updatedDraft;
  }

  /**
   * Get a draft by ID
   */
  async getDraft(draftId: string): Promise<WorkspaceDraft | null> {
    return await this.storage.get<WorkspaceDraft>(["workspace_drafts", draftId]);
  }

  /**
   * Get all drafts for a session
   */
  async getSessionDrafts(sessionId: string): Promise<WorkspaceDraft[]> {
    const drafts: WorkspaceDraft[] = [];

    // List all draft IDs for this session
    for await (
      const { value: draftId } of this.storage.list<string>([
        "workspace_drafts_by_session",
        sessionId,
      ])
    ) {
      if (draftId) {
        const draft = await this.getDraft(draftId);
        if (draft && draft.status === "draft") {
          drafts.push(draft);
        }
      }
    }

    return drafts;
  }

  /**
   * Mark a draft as published
   */
  async publishDraft(draftId: string): Promise<void> {
    const currentDraft = await this.getDraft(draftId);
    if (!currentDraft) {
      throw new Error(`Draft ${draftId} not found`);
    }

    // Create a copy for modification
    const updatedDraft = { ...currentDraft };
    updatedDraft.status = "published";
    updatedDraft.updatedAt = new Date().toISOString();

    const atomic = this.storage.atomic();
    atomic.set(["workspace_drafts", draftId], updatedDraft);
    atomic.set(["draft_metadata", "lastUpdated"], new Date().toISOString());

    const success = await atomic.commit();
    if (!success) {
      throw new Error(`Failed to publish draft ${draftId} - atomic operation failed`);
    }
  }

  /**
   * Get draft statistics
   */
  async getDraftStats(): Promise<{
    totalDrafts: number;
    draftsByStatus: Record<string, number>;
    lastUpdated: string | null;
    version: string | null;
  }> {
    const stats = {
      totalDrafts: 0,
      draftsByStatus: {
        draft: 0,
        published: 0,
        abandoned: 0,
      },
      lastUpdated: await this.storage.get<string>(["draft_metadata", "lastUpdated"]),
      version: await this.storage.get<string>(["draft_metadata", "version"]),
    };

    for await (const { value } of this.storage.list<WorkspaceDraft>(["workspace_drafts"])) {
      if (value) {
        stats.totalDrafts++;
        stats.draftsByStatus[value.status]++;
      }
    }

    return stats;
  }

  /**
   * Cleanup old abandoned drafts
   */
  async cleanupAbandonedDrafts(olderThan: Date): Promise<string[]> {
    const abandonedIds: string[] = [];

    for await (const { value } of this.storage.list<WorkspaceDraft>(["workspace_drafts"])) {
      if (
        value &&
        value.status === "draft" &&
        new Date(value.updatedAt) < olderThan
      ) {
        abandonedIds.push(value.id);
      }
    }

    if (abandonedIds.length > 0) {
      const atomic = this.storage.atomic();

      for (const id of abandonedIds) {
        const draft = await this.getDraft(id);
        if (draft) {
          draft.status = "abandoned";
          atomic.set(["workspace_drafts", id], draft);
        }
      }

      atomic.set(["draft_metadata", "lastUpdated"], new Date().toISOString());
      await atomic.commit();
    }

    return abandonedIds;
  }

  /**
   * Apply an operation to a draft
   */
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
          ...(config.system_prompt ? { prompts: { system: config.system_prompt as string } } : {}),
          ...(config.tools ? { tools: { mcp: config.tools as string[] } } : {}),
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

      case "remove_agent": {
        if (draft.config.agents && config.id) {
          delete draft.config.agents[config.id as string];
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

      case "update_job": {
        if (draft.config.jobs && draft.config.jobs[config.id as string]) {
          Object.assign(draft.config.jobs[config.id as string], config.updates);
        }
        break;
      }

      case "remove_job": {
        if (draft.config.jobs && config.id) {
          delete draft.config.jobs[config.id as string];
        }
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

      case "remove_tool": {
        if (draft.config.tools?.mcp?.servers && config.provider) {
          delete draft.config.tools.mcp.servers[config.provider as string];
        }
        break;
      }
    }
  }

  /**
   * Deep merge two partial workspace configurations
   */
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

  /**
   * Generate a human-readable summary of an operation
   */
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
      case "remove_agent":
        return `Removed agent '${config.id || config.name}'`;
      case "add_job":
        return `Created job '${config.id || config.name}' to coordinate agents`;
      case "update_job":
        return `Updated job '${config.id || config.name}'`;
      case "remove_job":
        return `Removed job '${config.id || config.name}'`;
      case "set_trigger":
        return `Configured ${config.provider} trigger for the workspace`;
      case "add_tool":
        return `Added ${config.provider} tool provider`;
      case "remove_tool":
        return `Removed ${config.provider} tool provider`;
      default:
        return `Applied ${operation} to workspace configuration`;
    }
  }

  /**
   * Close the storage adapter
   */
  async close(): Promise<void> {
    await this.storage.close();
  }

  /**
   * Get the underlying storage for advanced operations
   * Use sparingly - prefer domain-specific methods
   */
  getStorage(): KVStorage {
    return this.storage;
  }
}
