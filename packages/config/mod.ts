/**
 * @module @atlas/config
 *
 * Configuration management package for Atlas
 *
 * This package provides:
 * - Configuration schemas
 * - Default configurations
 * - Configuration validation
 * - Workspace initialization defaults
 */

// TODO: Move configuration schemas from src/config/
// TODO: Move workspace configuration logic from src/core/workspace-config.ts
// TODO: Move config loader from src/core/config-loader.ts

export const CONFIG_VERSION = "1.0.0";

// Placeholder exports - will be replaced as we migrate code
export interface WorkspaceConfig {
  name: string;
  version: string;
  // TODO: Add full schema
}

export interface SupervisorConfig {
  // TODO: Add supervisor configuration schema
}

export function loadConfig(path: string): Promise<WorkspaceConfig> {
  // TODO: Implement
  throw new Error("Not implemented yet");
}

export function validateConfig(config: unknown): WorkspaceConfig {
  // TODO: Implement validation
  throw new Error("Not implemented yet");
}
