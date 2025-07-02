/**
 * System Workspace Base Class
 *
 * System workspaces are special workspaces that provide Atlas features using
 * the Atlas workspace/job/agent architecture itself. They have special privileges
 * and can integrate with the daemon to provide enhanced functionality.
 */

// Import types are handled dynamically in the implementation
import { WorkspaceRuntime } from "./workspace-runtime.ts";
import type { WorkspaceConfig } from "@atlas/config";
import type { ResponseChannel } from "./session.ts";
import { logger } from "../utils/logger.ts";

/**
 * Abstract base class for system workspaces
 */
export abstract class SystemWorkspace {
  protected runtime?: WorkspaceRuntime;
  protected logger = logger.createChildLogger({
    component: "SystemWorkspace",
    workspace: this.getName(),
  });

  constructor(
    protected workspacePath: string,
    protected config?: Record<string, any>,
  ) {}

  /**
   * Get the system workspace name
   */
  abstract getName(): string;

  /**
   * Get the system workspace description
   */
  abstract getDescription(): string;

  /**
   * Initialize the system workspace
   */
  async initialize(): Promise<void> {
    this.logger.info("Initializing system workspace", {
      name: this.getName(),
      workspacePath: this.workspacePath,
    });

    // Load workspace configuration
    const workspaceConfig = await this.loadWorkspaceConfig();

    this.logger.debug("Loaded workspace configuration", {
      workspace: this.getName(),
      hasSignals: !!workspaceConfig.signals,
      signalCount: workspaceConfig.signals ? Object.keys(workspaceConfig.signals).length : 0,
      signalNames: workspaceConfig.signals ? Object.keys(workspaceConfig.signals) : [],
    });

    // Import necessary classes
    const { Workspace } = await import("./workspace.ts");
    const { WorkspaceMemberRole } = await import("../types/core.ts");

    // Create IWorkspace object from configuration
    const workspace = Workspace.fromConfig(workspaceConfig, {
      id: workspaceConfig.workspace.id || this.getName(),
      name: workspaceConfig.workspace.name || this.getName(),
      role: WorkspaceMemberRole.OWNER,
    });

    this.logger.debug("Workspace created from config", {
      workspace: this.getName(),
      workspaceSignals: Object.keys(workspace.signals || {}),
      workspaceSignalCount: Object.keys(workspace.signals || {}).length,
    });

    // Import atlas defaults for memory configuration
    const { atlasDefaults } = await import("@atlas/config");

    // Create a merged config structure that WorkspaceRuntime expects
    const mergedConfig = {
      atlas: {
        agents: {}, // System workspaces don't use atlas agents
        memory: atlasDefaults.memory, // Use the default memory configuration from atlas defaults
        supervisors: atlasDefaults.supervisors, // Include supervisor defaults
      },
      workspace: workspaceConfig,
      jobs: workspaceConfig.jobs,
      supervisorDefaults: atlasDefaults.supervisors, // Pass supervisor defaults
    };

    // Create workspace runtime
    this.runtime = new WorkspaceRuntime(
      workspace,
      mergedConfig,
      {
        lazy: true,
      },
    );

    this.logger.info("System workspace initialized", {
      name: this.getName(),
      signals: Object.keys(workspaceConfig.signals || {}),
      jobs: Object.keys(workspaceConfig.jobs || {}),
      agents: Object.keys(workspaceConfig.agents || {}),
    });
  }

  /**
   * Trigger a signal in the system workspace with optional response channel
   */
  async triggerSignal(
    signalName: string,
    payload: any,
    responseChannel?: ResponseChannel,
  ): Promise<void> {
    if (!this.runtime) {
      throw new Error("System workspace not initialized");
    }

    this.logger.debug("Triggering signal in system workspace", {
      workspace: this.getName(),
      signal: signalName,
      hasResponseChannel: !!responseChannel,
    });

    // Get the workspace object from runtime
    const workspace = (this.runtime as any).workspace;

    this.logger.debug("Looking for signal in workspace", {
      workspace: this.getName(),
      signalName,
      availableSignals: Object.keys(workspace.signals || {}),
      hasSignals: !!workspace.signals,
      signalCount: workspace.signals ? Object.keys(workspace.signals).length : 0,
    });

    // Get the signal from the workspace
    const signal = workspace.signals?.[signalName];

    if (!signal) {
      throw new Error(
        `Signal not found: ${signalName}. Available signals: ${
          Object.keys(workspace.signals || {}).join(", ")
        }`,
      );
    }

    // If we have a response channel, we need to pass it through the signal metadata
    // This is a temporary solution until we have proper response channel support
    if (responseChannel) {
      (signal as any).__responseChannel = responseChannel;
    }

    // Process the signal through the runtime
    await this.runtime.processSignal(signal, payload);
  }

  /**
   * Shutdown the system workspace
   */
  async shutdown(): Promise<void> {
    if (this.runtime) {
      this.logger.info("Shutting down system workspace", {
        name: this.getName(),
      });
      await this.runtime.shutdown();
    }
  }

  /**
   * Get workspace runtime (for advanced usage)
   */
  getRuntime(): WorkspaceRuntime | undefined {
    return this.runtime;
  }

  /**
   * Load the workspace configuration
   * Can be overridden by subclasses for custom loading
   */
  protected async loadWorkspaceConfig(): Promise<WorkspaceConfig> {
    // In a real implementation, this would load from the workspace path
    // For now, we'll return a minimal config that subclasses can override
    return {
      version: "1.0",
      workspace: {
        id: this.getName(),
        name: this.getName(),
        description: this.getDescription(),
      },
      signals: {},
      jobs: {},
      agents: {},
    };
  }

  /**
   * Register special routes for this system workspace
   * Called by the daemon when setting up system workspace routes
   */
  abstract registerRoutes(app: any): void;

  /**
   * Get available capabilities for this system workspace
   */
  getCapabilities(): string[] {
    return [
      "streaming",
      "internal-storage",
      "dynamic-tools",
      "bypass-validation",
    ];
  }
}
