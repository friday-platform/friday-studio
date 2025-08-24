/**
 * Configuration loader for v2 schemas
 * This demonstrates how the new schemas integrate with the configuration loading system
 */

import {
  AtlasConfigSchema,
  type JobSpecificationSchema,
  type MergedConfig,
  validateSignalPayload,
  type WorkspaceAgentConfigSchema,
  WorkspaceConfigSchema,
  type WorkspaceSignalConfigSchema,
} from "@atlas/config";
import type { ConfigurationAdapter } from "@atlas/storage";
import { z } from "zod/v4";

/**
 * Configuration loader v2 with improved type safety
 */
export class ConfigLoader {
  constructor(
    private adapter: ConfigurationAdapter,
    private workspacePath: string,
  ) {}

  /**
   * Load and validate workspace configuration from workspace.yml only
   */
  async loadWorkspace(): Promise<z.infer<typeof WorkspaceConfigSchema>> {
    const configPath = `${this.workspacePath}/workspace.yml`;

    if (!(await this.adapter.exists(configPath))) {
      throw new Error(`Workspace configuration not found at ${configPath}`);
    }

    const rawConfig = await this.adapter.readYaml(configPath);

    // Parse with comprehensive validation
    const result = WorkspaceConfigSchema.safeParse(rawConfig);
    if (!result.success) {
      throw new ConfigValidationError("Workspace configuration validation failed", result.error);
    }

    return result.data;
  }

  /**
   * Load and validate Atlas platform configuration
   */
  async loadAtlas(): Promise<z.infer<typeof AtlasConfigSchema> | null> {
    const configPath = `${this.workspacePath}/atlas.yml`;

    if (!(await this.adapter.exists(configPath))) {
      return null; // Atlas config is optional
    }

    const rawConfig = await this.adapter.readYaml(configPath);

    // If the raw config is empty or minimal, treat as no atlas config
    if (!rawConfig || (typeof rawConfig === "object" && Object.keys(rawConfig).length === 0)) {
      return null;
    }

    // Parse with comprehensive validation
    const result = AtlasConfigSchema.safeParse(rawConfig);
    if (!result.success) {
      throw new ConfigValidationError("Atlas configuration validation failed", result.error);
    }

    return result.data;
  }

  /**
   * Load both workspace.yml and atlas.yml, return them as separate configurations
   */
  async load(): Promise<MergedConfig> {
    const [workspace, atlas] = await Promise.all([this.loadWorkspace(), this.loadAtlas()]);

    const config: MergedConfig = { atlas, workspace };

    // Validate the configuration
    this.validateMergedConfig(config);

    return config;
  }

  /**
   * Validate the merged configuration
   */
  private validateMergedConfig(config: MergedConfig): void {
    // Get all signals from both configs
    const allSignals: Record<string, z.infer<typeof WorkspaceSignalConfigSchema>> = {
      ...(config.atlas?.signals || {}),
      ...(config.workspace.signals || {}),
    };

    // Get all agents from both configs
    const allAgents: Record<string, z.infer<typeof WorkspaceAgentConfigSchema>> = {
      ...(config.atlas?.agents || {}),
      ...(config.workspace.agents || {}),
    };

    // Get all jobs from both configs
    const allJobs: Record<string, z.infer<typeof JobSpecificationSchema>> = {
      ...(config.atlas?.jobs || {}),
      ...(config.workspace.jobs || {}),
    };

    // System signals should only be in system workspaces
    for (const [name, signal] of Object.entries(allSignals)) {
      if (signal.provider === "system" && !this.isSystemWorkspace(config)) {
        throw new Error(`System signal '${name}' can only be used in system workspaces`);
      }
    }

    // Validate agent references in jobs
    for (const [jobName, job] of Object.entries(allJobs)) {
      for (const agent of job.execution.agents) {
        const agentId = typeof agent === "string" ? agent : agent.id;
        if (!allAgents[agentId]) {
          throw new Error(`Job '${jobName}' references undefined agent '${agentId}'`);
        }
      }
    }

    // Validate signal references in triggers
    for (const [jobName, job] of Object.entries(allJobs)) {
      if (job.triggers) {
        for (const trigger of job.triggers) {
          if (!allSignals[trigger.signal]) {
            throw new Error(`Job '${jobName}' references undefined signal '${trigger.signal}'`);
          }
        }
      }
    }
  }

  /**
   * Check if this is a system workspace
   */
  private isSystemWorkspace(config: MergedConfig): boolean {
    // System workspaces are identified by their path or if it's the atlas platform
    return (
      this.workspacePath.includes("@atlas/system") ||
      config.workspace.workspace.id === "atlas-platform"
    );
  }

  /**
   * Validate a signal payload at runtime
   */
  validateSignalPayload(signalName: string, payload: unknown, config: MergedConfig): void {
    // Check both atlas and workspace for the signal
    const signal = config.workspace.signals?.[signalName] || config.atlas?.signals?.[signalName];

    if (!signal) {
      throw new Error(`Unknown signal: ${signalName}`);
    }

    const result = validateSignalPayload(signal, payload);
    if (!result.success) {
      throw new Error(
        `Signal payload validation failed for '${signalName}': ${
          (result as { success: false; error: string }).error
        }`,
      );
    }
  }
}

/**
 * Custom error class for configuration validation errors
 */
export class ConfigValidationError extends Error {
  constructor(
    message: string,
    public readonly zodError: z.ZodError,
  ) {
    // Include the prettified error details directly in the error message
    const prettyError = z.prettifyError(zodError);
    super(`${message}\n${prettyError}`);
    this.name = "ConfigValidationError";
  }

  /**
   * Get the prettified error details (for programmatic access if needed)
   */
  get details(): string {
    return z.prettifyError(this.zodError);
  }
}

// ==============================================================================
// USAGE EXAMPLE
// ==============================================================================

// Example usage:
// const adapter: ConfigurationAdapter = {
//   readYaml(_path: string) {
//     return Promise.resolve({});
//   },
//   exists(_path: string) {
//     return Promise.resolve(true);
//   },
//   getWorkspacePath() {
//     return "/workspace";
//   },
// };
// const loader = new ConfigLoader(adapter, "/workspace");
// const config = await loader.load();
