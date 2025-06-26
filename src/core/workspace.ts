import type {
  IWorkspace,
  IWorkspaceAction,
  IWorkspaceAgent,
  IWorkspaceMember,
  IWorkspaceSignal,
  IWorkspaceSource,
  IWorkspaceWorkflow,
} from "../types/core.ts";
import { AtlasScope } from "./scope.ts";

/**
 * Workspace is a pure domain model representing the workspace state.
 * It does NOT handle runtime concerns like workers, HTTP, or signal processing.
 */
export class Workspace extends AtlasScope implements IWorkspace {
  public members: IWorkspaceMember;
  public signals: Record<string, IWorkspaceSignal> = {};
  public agents: Record<string, IWorkspaceAgent> = {};
  public workflows: Record<string, IWorkspaceWorkflow> = {};
  public sources: Record<string, IWorkspaceSource> = {};
  public actions: Record<string, IWorkspaceAction> = {};

  // Note: supervisor is inherited from AtlasScope and created by runtime, not by workspace

  constructor(owner: IWorkspaceMember) {
    super();
    this.members = owner;
  }

  // Pure domain methods - just manage state

  addSignal(signal: IWorkspaceSignal): Error | null {
    if (this.signals[signal.id]) {
      return new Error(`Signal ${signal.id} already exists`);
    }
    this.signals[signal.id] = signal;
    return null;
  }

  removeSignal(signalId: string): Error | null {
    if (!this.signals[signalId]) {
      return new Error(`Signal ${signalId} not found`);
    }
    delete this.signals[signalId];
    return null;
  }

  addAgent(agent: IWorkspaceAgent): Error | null {
    if (this.agents[agent.id]) {
      return new Error(`Agent ${agent.id} already exists`);
    }
    this.agents[agent.id] = agent;
    return null;
  }

  removeAgent(agentId: string): Error | null {
    if (!this.agents[agentId]) {
      return new Error(`Agent ${agentId} not found`);
    }
    delete this.agents[agentId];
    return null;
  }

  addWorkflow(workflow: IWorkspaceWorkflow): Error | null {
    if (this.workflows[workflow.id]) {
      return new Error(`Workflow ${workflow.id} already exists`);
    }
    this.workflows[workflow.id] = workflow;
    return null;
  }

  removeWorkflow(workflowId: string): Error | null {
    if (!this.workflows[workflowId]) {
      return new Error(`Workflow ${workflowId} not found`);
    }
    delete this.workflows[workflowId];
    return null;
  }

  addSource(source: IWorkspaceSource): Error | null {
    if (this.sources[source.id]) {
      return new Error(`Source ${source.id} already exists`);
    }
    this.sources[source.id] = source;
    return null;
  }

  removeSource(sourceId: string): Error | null {
    if (!this.sources[sourceId]) {
      return new Error(`Source ${sourceId} not found`);
    }
    delete this.sources[sourceId];
    return null;
  }

  addAction(action: IWorkspaceAction): Error | null {
    if (this.actions[action.id]) {
      return new Error(`Action ${action.id} already exists`);
    }
    this.actions[action.id] = action;
    return null;
  }

  removeAction(actionId: string): Error | null {
    if (!this.actions[actionId]) {
      return new Error(`Action ${actionId} not found`);
    }
    delete this.actions[actionId];
    return null;
  }

  // Note: These are removed as they're runtime concerns
  // currentActiveSessions() - moved to WorkspaceRuntime
  // getAllArtifacts() - moved to WorkspaceRuntime
  // addSession() - moved to WorkspaceRuntime
  // removeSession() - moved to WorkspaceRuntime
  // addArtifact() - moved to WorkspaceRuntime

  /**
   * Get a snapshot of the workspace state
   */
  snapshot(): object {
    return {
      id: this.id,
      members: this.members,
      signals: Object.keys(this.signals).length,
      agents: Object.keys(this.agents).length,
      workflows: Object.keys(this.workflows).length,
      sources: Object.keys(this.sources).length,
      actions: Object.keys(this.actions).length,
      memory: this.memory.size(),
      context: this.context.size(),
      messages: this.messages.history.length,
    };
  }

  /**
   * Export the full workspace configuration
   */
  toConfig(): any {
    return {
      id: this.id,
      members: this.members,
      signals: Object.values(this.signals).map((s) => ({
        id: s.id,
        provider: s.provider,
        // Add other signal properties as needed
      })),
      agents: Object.values(this.agents).map((a) => ({
        id: a.id,
        name: a.name(),
        type: (a as any).type || "unknown",
        status: a.status,
      })),
      workflows: Object.values(this.workflows),
      sources: Object.values(this.sources),
      actions: Object.values(this.actions),
    };
  }

  /**
   * Create a workspace from configuration
   */
  static fromConfig(config: any, owner: IWorkspaceMember): Workspace {
    const workspace = new Workspace(owner);

    // Set ID from owner (which comes from registry entry)
    if (owner.id) {
      (workspace as any).id = owner.id;
    }

    // Add signals - handle both array and object formats
    if (config.signals) {
      if (Array.isArray(config.signals)) {
        for (const signal of config.signals) {
          workspace.addSignal(signal);
        }
      } else {
        // Handle object format from YAML
        for (const [id, signalConfig] of Object.entries(config.signals)) {
          const typedSignalConfig = signalConfig as Record<string, any>;
          workspace.addSignal({
            id,
            ...typedSignalConfig,
          } as IWorkspaceSignal);
        }
      }
    }

    // Note: Agents are not added here as they need to be created via AgentRegistry
    // The runtime will handle agent recreation

    return workspace;
  }
}
