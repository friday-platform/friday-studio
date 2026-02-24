/**
 * Configuration loader for v2 schemas
 * This demonstrates how the new schemas integrate with the configuration loading system
 */

import {
  AtlasConfigSchema,
  type MergedConfig,
  validateSignalPayload,
  WorkspaceConfigSchema,
  type WorkspaceSignalConfigSchema,
} from "@atlas/config";
import { z } from "zod";
import type { ConfigurationAdapter } from "./configuration-adapter.ts";

/**
 * Configuration loader v2 with improved type safety
 */
export class ConfigLoader {
  constructor(
    private adapter: ConfigurationAdapter,
    private workspacePath: string,
  ) {}

  /**
   * Resolve the workspace configuration file path. Prefer persistent when both exist.
   */
  private async resolveWorkspaceConfigPath(): Promise<{ path: string; ephemeral: boolean }> {
    const persistentPath = `${this.workspacePath}/workspace.yml`;
    const ephemeralPath = `${this.workspacePath}/eph_workspace.yml`;

    const hasPersistent = await this.adapter.exists(persistentPath);
    const hasEphemeral = await this.adapter.exists(ephemeralPath);

    if (hasPersistent) {
      return { path: persistentPath, ephemeral: false };
    }
    if (hasEphemeral) {
      return { path: ephemeralPath, ephemeral: true };
    }
    throw new ConfigNotFoundError(this.workspacePath);
  }

  /**
   * Load and validate workspace configuration from workspace.yml or eph_workspace.yml
   */
  async loadWorkspace(): Promise<z.infer<typeof WorkspaceConfigSchema>> {
    const { path: configPath } = await this.resolveWorkspaceConfigPath();

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

    // System signals should only be in system workspaces
    for (const [name, signal] of Object.entries(allSignals)) {
      if (signal.provider === "system" && !this.isSystemWorkspace(config)) {
        throw new Error(`System signal '${name}' can only be used in system workspaces`);
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
      throw new Error(`Signal payload validation failed for '${signalName}': ${result.error}`);
    }
  }
}

/**
 * Error thrown when workspace configuration file is not found
 */
export class ConfigNotFoundError extends Error {
  public readonly code = "CONFIG_NOT_FOUND";

  constructor(public readonly workspacePath: string) {
    super(
      `Workspace configuration not found at ${workspacePath}/workspace.yml or ${workspacePath}/eph_workspace.yml`,
    );
    this.name = "ConfigNotFoundError";
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
