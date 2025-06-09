/**
 * Loads workspace from configuration with provider support
 */

import { Workspace } from "./workspace.ts";
import { WorkspaceConfig } from "./workspace-config.ts";
import { ProviderRegistry } from "./providers/registry.ts";
import { ProviderStateManager } from "./providers/state-manager.ts";
import type { IWorkspace, IWorkspaceSignal } from "../types/core.ts";
import type { ISignalProvider } from "./providers/types.ts";
import { ProviderType } from "./providers/types.ts";

export class WorkspaceLoader {
  private config: WorkspaceConfig;
  private stateManager: ProviderStateManager;
  private registry: ProviderRegistry;

  constructor(config: WorkspaceConfig, workspaceDir: string = ".") {
    this.config = config;
    this.stateManager = new ProviderStateManager(
      config.id || "default",
      `${workspaceDir}/.atlas`,
    );
    this.registry = ProviderRegistry.getInstance();
  }

  async load(): Promise<IWorkspace> {
    console.log(`[WorkspaceLoader] Loading workspace: ${this.config.name}`);

    // Load provider state
    await this.stateManager.load();

    // Create base workspace
    const workspace = new Workspace({
      id: this.config.owner || "default",
      name: this.config.owner || "default",
      role: "owner" as any,
    });

    // Set workspace ID if provided
    if (this.config.id) {
      (workspace as any).id = this.config.id;
    }

    // Load providers
    await this.loadProviders();

    // Load signals
    await this.loadSignals(workspace);

    // Load agents
    await this.loadAgents(workspace);

    // Load workflows
    if (this.config.workflows) {
      for (const workflowConfig of this.config.workflows) {
        // TODO: Implement workflow loading
        console.log(
          `[WorkspaceLoader] TODO: Load workflow ${workflowConfig.id}`,
        );
      }
    }

    // Save updated provider state
    await this.stateManager.save();

    console.log(`[WorkspaceLoader] Workspace loaded successfully`);
    return workspace;
  }

  private async loadProviders(): Promise<void> {
    if (!this.config.providers) return;

    console.log(
      `[WorkspaceLoader] Loading ${this.config.providers.length} providers`,
    );

    for (const providerConfig of this.config.providers) {
      try {
        const provider = await this.registry.loadFromConfig(providerConfig);

        // Check saved state
        const savedState = this.stateManager.getProviderState(provider.id);
        if (savedState) {
          console.log(
            `[WorkspaceLoader] Found saved state for provider ${provider.id}`,
          );
          // Provider can use saved state to restore itself
        }

        // Setup provider
        await provider.setup();

        // Save state
        this.stateManager.setProviderState(provider.id, provider.getState());

        console.log(
          `[WorkspaceLoader] Provider ${provider.id} loaded and ready`,
        );
      } catch (error) {
        console.error(
          `[WorkspaceLoader] Failed to load provider ${providerConfig.id}:`,
          error,
        );
      }
    }
  }

  private async loadSignals(workspace: IWorkspace): Promise<void> {
    if (!this.config.signals) return;

    console.log(
      `[WorkspaceLoader] Loading ${this.config.signals.length} signals`,
    );

    for (const signalConfig of this.config.signals) {
      try {
        // Get provider
        const provider = this.registry.get(signalConfig.providerId);
        if (!provider) {
          throw new Error(`Provider not found: ${signalConfig.providerId}`);
        }

        if (provider.type !== ProviderType.SIGNAL) {
          throw new Error(
            `Provider ${signalConfig.providerId} is not a signal provider`,
          );
        }

        // Create signal through provider
        const signalProvider = provider as ISignalProvider;
        const providerSignal = signalProvider.createSignal(signalConfig);

        // Convert to runtime signal
        const runtimeSignal = providerSignal.toRuntimeSignal();

        // Add to workspace
        const error = workspace.addSignal(runtimeSignal);
        if (error) {
          throw error;
        }

        console.log(`[WorkspaceLoader] Signal ${signalConfig.id} loaded`);
      } catch (error) {
        console.error(
          `[WorkspaceLoader] Failed to load signal ${signalConfig.id}:`,
          error,
        );
      }
    }
  }

  private async loadAgents(workspace: IWorkspace): Promise<void> {
    if (!this.config.agents) return;

    console.log(
      `[WorkspaceLoader] Loading ${this.config.agents.length} agents`,
    );

    for (const agentConfig of this.config.agents) {
      try {
        // Get provider
        const provider = this.registry.get(agentConfig.providerId);
        if (!provider) {
          throw new Error(`Provider not found: ${agentConfig.providerId}`);
        }

        if (provider.type !== ProviderType.AGENT) {
          throw new Error(
            `Provider ${agentConfig.providerId} is not an agent provider`,
          );
        }

        // For now, just log - agent creation is handled by AgentRegistry
        console.log(
          `[WorkspaceLoader] Agent ${agentConfig.id} configured with provider ${agentConfig.providerId}`,
        );

        // Store agent config for runtime to use
        (workspace as any).agentConfigs = (workspace as any).agentConfigs || {};
        (workspace as any).agentConfigs[agentConfig.id] = agentConfig;
      } catch (error) {
        console.error(
          `[WorkspaceLoader] Failed to configure agent ${agentConfig.id}:`,
          error,
        );
      }
    }
  }

  /**
   * Save current workspace state
   */
  async save(): Promise<void> {
    await this.stateManager.save();
  }

  /**
   * Export workspace configuration
   */
  exportConfig(): WorkspaceConfig {
    return { ...this.config };
  }
}
