import type { IWorkspace, IWorkspaceAgent } from "../types/core.ts";
import type { AgentMetadata } from "../types/agent.ts";
import type { RuntimeAgentConfig } from "./workspace-runtime.ts";
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
    agentConfigs: Record<string, RuntimeAgentConfig>,
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
          logger.error(
            `Failed to add agent to workspace: ${addError.message}`,
            {
              workspaceId: workspace.id,
              agentId,
            },
          );
          result.failed.push({ id: agentId, error: addError.message });
        } else {
          logger.info(
            `Loaded agent: ${agentId} (${(agent as any).type || "unknown"})`,
            {
              workspaceId: workspace.id,
              agentId,
            },
          );
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
    agentConfig: RuntimeAgentConfig,
  ): Promise<IWorkspaceAgent> {
    // Create a metadata-only agent object that the AgentSupervisor can use
    const metadataAgent = {
      id: agentId,
      name: agentConfig.name || agentId,
      nickname: agentConfig.nickname || agentId,
      version: agentConfig.version || "1.0.0",
      provider: agentConfig.provider || "user",
      purpose: agentConfig.purpose || "",
      type: agentConfig.type,
      config: agentConfig,
      // Add metadata flag so supervisor knows this is config-only
      isMetadata: true,
      // Required IWorkspaceAgent interface methods
      status: "ready",
      host: "supervisor",
      controls: () => ({}),
      getAgentPrompts: () => ({
        system: agentConfig.prompts?.system || "",
        user: "",
      }),
      // These will not be called for metadata-only agents, but required by interface
      invoke: async (message: string) => {
        throw new Error(
          `Metadata-only agent ${agentId} cannot be invoked directly. Use AgentSupervisor.`,
        );
      },
      invokeStream: async function* (message: string) {
        throw new Error(
          `Metadata-only agent ${agentId} cannot be invoked directly. Use AgentSupervisor.`,
        );
      },
      // Base agent interface methods
      prompts: { system: agentConfig.prompts?.system || "", user: "" },
      gates: [],
      newConversation: () => {
        throw new Error("Not implemented for metadata agents");
      },
      getConversation: () => {
        throw new Error("Not implemented for metadata agents");
      },
      archiveConversation: () => {
        throw new Error("Not implemented for metadata agents");
      },
      deleteConversation: () => {
        throw new Error("Not implemented for metadata agents");
      },
      scope: () => {
        throw new Error("Not implemented for metadata agents");
      },
    };

    return metadataAgent as unknown as IWorkspaceAgent;
  }

  /**
   * Reload agents in a workspace (useful for hot-reloading)
   */
  static async reloadAgents(
    workspace: IWorkspace,
    agentConfigs: Record<string, RuntimeAgentConfig>,
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
  static serializeAgentMetadata(
    agents: Record<string, IWorkspaceAgent>,
  ): Record<string, any> {
    return Object.entries(agents).reduce((acc, [key, agent]) => {
      const agentTyped = agent as any;
      acc[key] = {
        id: key,
        name: typeof agentTyped.name === "function" ? agentTyped.name() : agentTyped.name || key,
        type: agentTyped.type || key.replace("-agent", ""),
        purpose: typeof agentTyped.purpose === "function"
          ? agentTyped.purpose()
          : agentTyped.purpose || "",
        // CRITICAL: Preserve config and metadata flags for proper agent execution
        config: agentTyped.config || {},
        isMetadata: agentTyped.isMetadata || false,
      };
      return acc;
    }, {} as Record<string, any>);
  }
}
