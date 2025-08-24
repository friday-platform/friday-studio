import { ensureDir } from "@std/fs";
import { join } from "@std/path";
import type { AgentMetadata } from "../types/agent.ts";
import type { IWorkspace, IWorkspaceMember, WorkspaceMemberRole } from "../types/core.ts";
import { Workspace } from "./workspace.ts";

export class AtlasWorkspaceManager {
  private workspacesPath: string;
  private workspaces: Map<string, IWorkspace> = new Map();

  constructor(storagePath?: string) {
    this.workspacesPath = storagePath || join(Deno.cwd(), ".atlas", "workspaces");
  }

  private async ensureLoaded(): Promise<void> {
    if (this.workspaces.size === 0) {
      await this.loadWorkspaces();
    }
  }

  async createWorkspace(name: string, ownerName: string): Promise<IWorkspace> {
    const owner: IWorkspaceMember = {
      id: crypto.randomUUID(),
      name: ownerName,
      role: "owner" as WorkspaceMemberRole,
    };

    const workspace = new Workspace(owner);

    // Store workspace metadata
    const workspaceMeta = {
      id: workspace.id,
      name,
      owner,
      createdAt: new Date(),
      path: join(this.workspacesPath, workspace.id),
    };

    await this.saveWorkspace(workspace, workspaceMeta);
    this.workspaces.set(workspace.id, workspace);

    return workspace;
  }

  async getWorkspace(id: string): Promise<IWorkspace | null> {
    await this.ensureLoaded();
    return this.workspaces.get(id) || null;
  }

  async listWorkspaces(): Promise<IWorkspace[]> {
    await this.ensureLoaded();
    return Array.from(this.workspaces.values());
  }

  async deleteWorkspace(id: string): Promise<boolean> {
    const workspace = this.workspaces.get(id);
    if (!workspace) {
      return false;
    }

    try {
      const workspacePath = join(this.workspacesPath, id);
      await Deno.remove(workspacePath, { recursive: true });
      this.workspaces.delete(id);
      return true;
    } catch (error) {
      console.error(`Failed to delete workspace ${id}:`, error);
      return false;
    }
  }

  getWorkspacePath(id: string): string {
    return join(this.workspacesPath, id);
  }

  async updateWorkspace(workspace: IWorkspace): Promise<void> {
    // Save updated workspace state
    const workspaceMeta = {
      id: workspace.id,
      name: `workspace-${workspace.id}`, // TODO: Store actual name
      owner: workspace.members,
      updatedAt: new Date(),
      path: join(this.workspacesPath, workspace.id),
    };

    await this.saveWorkspace(workspace, workspaceMeta);
  }

  private async saveWorkspace(workspace: IWorkspace, meta: any): Promise<void> {
    const workspacePath = join(this.workspacesPath, workspace.id);
    await ensureDir(workspacePath);

    // Save workspace metadata
    const metaPath = join(workspacePath, "workspace.json");
    await Deno.writeTextFile(
      metaPath,
      JSON.stringify({ ...meta, snapshot: workspace.snapshot() }, null, 2),
    );

    // Save workspace state with agent metadata instead of full agents
    const agentMetadata: Record<string, AgentMetadata> = {};
    for (const [id, agent] of Object.entries(workspace.agents)) {
      agentMetadata[id] = {
        id: agent.id,
        type: this.getAgentType(agent),
        config: this.getAgentConfig(agent),
        parentScopeId: agent.parentScopeId,
      };
    }

    const statePath = join(workspacePath, "state.json");
    await Deno.writeTextFile(
      statePath,
      JSON.stringify(
        {
          id: workspace.id,
          members: workspace.members,
          signals: workspace.signals,
          agentMetadata,
          workflows: workspace.workflows,
          sources: workspace.sources,
          actions: workspace.actions,
          prompts: workspace.prompts,
        },
        null,
        2,
      ),
    );
  }

  private async loadWorkspaces(): Promise<void> {
    try {
      await ensureDir(this.workspacesPath);

      for await (const dirEntry of Deno.readDir(this.workspacesPath)) {
        if (dirEntry.isDirectory) {
          try {
            const workspace = await this.loadWorkspace(dirEntry.name);
            if (workspace) {
              this.workspaces.set(workspace.id, workspace);
            }
          } catch (error) {
            console.warn(`Failed to load workspace ${dirEntry.name}:`, error);
          }
        }
      }
    } catch (error) {
      // Directory doesn't exist yet, that's fine
      if (!(error instanceof Deno.errors.NotFound)) {
        console.warn("Failed to load workspaces:", error);
      }
    }
  }

  private async loadWorkspace(id: string): Promise<IWorkspace | null> {
    const workspacePath = join(this.workspacesPath, id);
    const statePath = join(workspacePath, "state.json");

    try {
      // Load state
      const stateContent = await Deno.readTextFile(statePath);
      const state = JSON.parse(stateContent);

      // Recreate workspace
      const workspace = new Workspace(state.members);

      // Restore properties
      workspace.id = state.id;
      workspace.signals = state.signals || {};
      workspace.workflows = state.workflows || {};
      workspace.sources = state.sources || {};
      workspace.actions = state.actions || {};
      workspace.prompts = state.prompts || { system: "", user: "" };

      // Recreate agents from metadata
      const agentMetadata = state.agentMetadata || state.agents || {}; // Backward compatibility
      for (const [id, metadata] of Object.entries(agentMetadata)) {
        try {
          if (typeof metadata === "object" && metadata !== null && "type" in metadata) {
            // Legacy agent restoration - now handled by AgentLoader during runtime
            console.warn(
              `Skipping agent restoration for ${id} - agents are now loaded from configuration`,
            );
          }
          // Skip old format agents (they'll be lost but we can recreate them)
        } catch (error) {
          console.warn(`Failed to recreate agent ${id}:`, error);
        }
      }

      return workspace;
    } catch (error) {
      console.warn(`Failed to load workspace ${id}:`, error);
      return null;
    }
  }

  private getAgentType(agent: any): string {
    // Try to determine agent type from class name or other properties
    if (agent.constructor?.name === "EchoAgent") return "echo";
    if (agent.constructor?.name === "ClaudeAgent") return "claude";
    if (agent.constructor?.name === "TelephoneAgent") return "telephone";

    // Fallback: try to infer from agent name
    const name = agent.name?.() || "";
    if (name.includes("Echo")) return "echo";
    if (name.includes("Claude")) return "claude";
    if (name.includes("Telephone")) return "telephone";

    return "unknown";
  }

  private getAgentConfig(agent: any): any {
    // Extract agent-specific configuration
    const config: any = {};

    if (agent.model) {
      config.model = agent.model;
    }

    if (agent.agentNumber) {
      config.agentNumber = agent.agentNumber;
    }

    return Object.keys(config).length > 0 ? config : undefined;
  }
}
