/**
 * Mutation orchestrator for workspace configuration partial updates
 *
 * Coordinates the load → mutate → validate → write cycle, respecting
 * ephemeral vs persistent source files.
 */

import { readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { stringifyError } from "@atlas/utils";
import { parse as parseYaml, stringify as stringifyYaml } from "@std/yaml";
import { ConfigLoader, ConfigNotFoundError } from "../config-loader.ts";
import { type WorkspaceConfig, WorkspaceConfigSchema } from "../workspace.ts";
import type { ConfigWriter, MutationResult, ValidationError, WriteError } from "./types.ts";

// ==============================================================================
// CONFIG PATH RESOLVER
// ==============================================================================

/**
 * Resolves which config file to use for a workspace.
 * Prefers persistent (workspace.yml) over ephemeral (eph_workspace.yml).
 *
 * @param workspacePath - Path to the workspace directory
 * @returns Path to the config file and whether it's ephemeral
 * @throws ConfigNotFoundError if neither file exists
 */
export async function resolveConfigPath(
  workspacePath: string,
): Promise<{ path: string; ephemeral: boolean }> {
  const persistentPath = `${workspacePath}/workspace.yml`;
  const ephemeralPath = `${workspacePath}/eph_workspace.yml`;

  const hasPersistent = await fileExists(persistentPath);
  const hasEphemeral = await fileExists(ephemeralPath);

  if (hasPersistent) {
    return { path: persistentPath, ephemeral: false };
  }
  if (hasEphemeral) {
    return { path: ephemeralPath, ephemeral: true };
  }
  throw new ConfigNotFoundError(workspacePath);
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

// ==============================================================================
// FILESYSTEM CONFIG WRITER
// ==============================================================================

/**
 * Default ConfigWriter implementation that writes to the filesystem.
 * Serializes config to YAML and writes to the specified path.
 *
 * Uses atomic write (write to temp file, then rename) to prevent
 * config corruption if a crash or power loss occurs mid-write.
 */
export class FilesystemConfigWriter implements ConfigWriter {
  async write(configPath: string, config: WorkspaceConfig): Promise<void> {
    const yaml = stringifyYaml(config);
    const tempPath = `${configPath}.tmp`;

    // Write to temp file first
    await writeFile(tempPath, yaml, "utf-8");

    try {
      // Atomically replace the target file
      await rename(tempPath, configPath);
    } catch (renameError) {
      // Clean up temp file on rename failure
      try {
        await unlink(tempPath);
      } catch {
        // Ignore cleanup errors - the rename error is the important one
      }
      throw renameError;
    }
  }
}

// ==============================================================================
// APPLY MUTATION ORCHESTRATOR
// ==============================================================================

/**
 * Adapter for ConfigLoader that uses node:fs stat for existence checks.
 */
const createConfigAdapter = (workspacePath: string) => ({
  async readYaml(path: string): Promise<unknown> {
    const content = await readFile(path, "utf-8");
    return parseYaml(content);
  },
  exists(path: string): Promise<boolean> {
    return fileExists(path);
  },
  getWorkspacePath(): string {
    return workspacePath;
  },
});

/**
 * Options for applyMutation.
 */
export interface ApplyMutationOptions {
  /** ConfigWriter implementation (defaults to FilesystemConfigWriter) */
  writer?: ConfigWriter;
  /**
   * Callback invoked after validation succeeds but before disk write.
   * Useful for storing history or performing other side effects that should
   * only occur when the mutation will succeed.
   * If the callback throws, the mutation returns a WriteError.
   */
  onBeforeWrite?: (configPath: string, config: WorkspaceConfig) => Promise<void>;
}

/**
 * Applies a mutation function to a workspace configuration.
 *
 * Handles the complete lifecycle:
 * 1. Resolve config file path (eph_workspace.yml or workspace.yml)
 * 2. Load current config via ConfigLoader
 * 3. Apply mutation function
 * 4. Validate result against WorkspaceConfigSchema
 * 5. Call onBeforeWrite callback (if provided)
 * 6. Serialize to YAML and write back to source file
 *
 * @param workspacePath - Path to the workspace directory
 * @param mutationFn - Pure function that transforms config, returning MutationResult
 * @param options - Optional configuration including writer and onBeforeWrite callback
 * @returns MutationResult with updated config on success, or error on failure
 *
 * @example
 * ```typescript
 * const result = await applyMutation(
 *   "/path/to/workspace",
 *   (config) => createSignal(config, "my-webhook", { provider: "http", config: { path: "/hook" } }),
 *   { onBeforeWrite: async (path, config) => await storeHistory(config) }
 * );
 * if (result.ok) {
 *   console.log("Config updated:", result.value);
 * } else {
 *   console.error("Mutation failed:", result.error);
 * }
 * ```
 */
export async function applyMutation(
  workspacePath: string,
  mutationFn: (config: WorkspaceConfig) => MutationResult<WorkspaceConfig>,
  options: ApplyMutationOptions = {},
): Promise<MutationResult<WorkspaceConfig>> {
  const { writer = new FilesystemConfigWriter(), onBeforeWrite } = options;
  // 1. Resolve config file path
  const { path: configPath } = await resolveConfigPath(workspacePath);

  // 2. Load current config
  const adapter = createConfigAdapter(workspacePath);
  const loader = new ConfigLoader(adapter, workspacePath);
  const currentConfig = await loader.loadWorkspace();

  // 3. Apply mutation
  const mutationResult = mutationFn(currentConfig);
  if (!mutationResult.ok) {
    return mutationResult;
  }

  // 4. Validate result against full schema
  const validationResult = WorkspaceConfigSchema.safeParse(mutationResult.value);
  if (!validationResult.success) {
    const error: ValidationError = {
      type: "validation",
      message: "Mutated config failed validation",
      issues: validationResult.error.issues,
    };
    return { ok: false, error };
  }

  // 5. Call onBeforeWrite callback (e.g., to store history)
  if (onBeforeWrite) {
    try {
      await onBeforeWrite(configPath, validationResult.data);
    } catch (err) {
      const error: WriteError = { type: "write", message: stringifyError(err) };
      return { ok: false, error };
    }
  }

  // 6. Write back to source file
  try {
    await writer.write(configPath, validationResult.data);
  } catch (err) {
    const error: WriteError = { type: "write", message: stringifyError(err) };
    return { ok: false, error };
  }

  return { ok: true, value: validationResult.data };
}
