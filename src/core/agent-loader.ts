import type { IWorkspace, IWorkspaceAgent } from "../types/core.ts";
import { type AgentMetadata, AgentRegistry } from "./agent-registry.ts";
import { logger } from "../utils/logger.ts";

export interface AgentLoadResult {
  loaded: IWorkspaceAgent[];
  failed: Array<{ id: string; error: string }>;
}

/**
 * Centralized service for loading agents into workspaces.
 * Consolidates agent creation logic and handles errors consistently.
 */
export class AgentLoader {
  /**
   * Load multiple agents from configuration into a workspace
   */
  static async loadAgents(
    workspace: IWorkspace,
    agentConfigs: Record<string, any>,
  ): Promise<AgentLoadResult> {
    const result: AgentLoadResult = {
      loaded: [],
      failed: [],
    };

    if (!agentConfigs) {
      return result;
    }

    const loadPromises = Object.entries(agentConfigs).map(
      ([agentId, agentConfig]) => this.loadSingleAgent(workspace, agentId, agentConfig),
    );

    const results = await Promise.allSettled(loadPromises);

    for (let i = 0; i < results.length; i++) {
      const [agentId] = Object.entries(agentConfigs)[i];
      const promiseResult = results[i];

      if (promiseResult.status === "fulfilled") {
        const agent = promiseResult.value;
        result.loaded.push(agent);

        // Add to workspace
        const addError = workspace.addAgent(agent);
        if (addError) {
          logger.error(`Failed to add agent to workspace: ${addError.message}`, {
            workspaceId: workspace.id,
            agentId,
          });
          result.failed.push({ id: agentId, error: addError.message });
        } else {
          logger.info(`Loaded agent: ${agentId} (${(agent as any).type || "unknown"})`, {
            workspaceId: workspace.id,
            agentId,
          });
        }
      } else {
        const error = promiseResult.reason;
        const errorMessage = error instanceof Error ? error.message : String(error);

        logger.error(`Failed to load agent ${agentId}`, {
          workspaceId: workspace.id,
          agentId,
          error: errorMessage,
        });

        result.failed.push({ id: agentId, error: errorMessage });
      }
    }

    return result;
  }

  /**
   * Load a single agent with proper error handling and ID assignment
   */
  private static async loadSingleAgent(
    workspace: IWorkspace,
    agentId: string,
    agentConfig: any,
  ): Promise<IWorkspaceAgent> {
    const metadata: AgentMetadata = {
      id: agentId,
      type: agentConfig.type,
      config: agentConfig,
      parentScopeId: workspace.id,
    };

    // Create agent via registry
    const agent = await AgentRegistry.createAgent(metadata);

    // Ensure agent has the correct ID (consolidates the (agent as any).id pattern)
    if ((agent as any).id !== agentId) {
      (agent as any).id = agentId;
    }

    // Set agent type for metadata if not already set
    if (!(agent as any).type) {
      (agent as any).type = agentConfig.type;
    }

    // Pass through agent configuration for model selection and other settings
    (agent as any).config = agentConfig;

    return agent;
  }

  /**
   * Reload agents in a workspace (useful for hot-reloading)
   */
  static async reloadAgents(
    workspace: IWorkspace,
    agentConfigs: Record<string, any>,
  ): Promise<AgentLoadResult> {
    // Clear existing agents
    for (const agentId of Object.keys(workspace.agents)) {
      workspace.removeAgent(agentId);
    }

    // Load new agents
    return await this.loadAgents(workspace, agentConfigs);
  }

  /**
   * Get agent metadata for serialization (used by workspace-runtime)
   */
  static serializeAgentMetadata(agents: Record<string, IWorkspaceAgent>): Record<string, any> {
    return Object.entries(agents).reduce(
      (acc, [key, agent]) => {
        const agentTyped = agent as any;
        acc[key] = {
          id: key,
          name: agentTyped.name?.() || key,
          type: agentTyped.type || key.replace("-agent", ""),
          purpose: agentTyped.purpose?.() || "",
        };
        return acc;
      },
      {} as Record<string, any>,
    );
  }
}
