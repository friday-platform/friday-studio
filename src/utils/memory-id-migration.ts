/**
 * Memory ID Migration Utility
 *
 * Migrates workspace memory directories from UUID names to human-readable names
 * to match the workspace IDs stored in the registry.
 */

import { exists, move } from "@std/fs";
import { join } from "@std/path";
import { createRegistryStorage, StorageConfigs } from "../core/storage/index.ts";
import { getAtlasMemoryDir } from "./paths.ts";

export interface MemoryIdMigrationResult {
  success: boolean;
  migratedDirectories: Array<{ oldPath: string; newPath: string; workspaceName: string }>;
  errors: string[];
  warnings: string[];
}

/**
 * Check if UUID-named memory directories exist that could be migrated
 */
export async function hasUuidMemoryDirectories(): Promise<boolean> {
  const memoryDir = getAtlasMemoryDir();

  try {
    for await (const entry of Deno.readDir(memoryDir)) {
      if (entry.isDirectory && !entry.name.startsWith(".")) {
        // Check if directory name looks like a UUID
        if (isUuidFormat(entry.name)) {
          return true;
        }
      }
    }
  } catch (error) {
    // Memory directory might not exist yet
  }

  return false;
}

/**
 * List all UUID-named memory directories
 */
export async function listUuidMemoryDirectories(): Promise<string[]> {
  const memoryDir = getAtlasMemoryDir();
  const uuidDirs: string[] = [];

  try {
    for await (const entry of Deno.readDir(memoryDir)) {
      if (entry.isDirectory && !entry.name.startsWith(".")) {
        if (isUuidFormat(entry.name)) {
          uuidDirs.push(entry.name);
        }
      }
    }
  } catch (error) {
    // Memory directory might not exist yet
  }

  return uuidDirs;
}

/**
 * Migrate UUID-named memory directories to human-readable names
 *
 * This function:
 * 1. Lists all workspaces from the registry (which have human-readable IDs)
 * 2. For each workspace, checks if there are any UUID memory directories that might belong to it
 * 3. Provides a mapping suggestion or allows manual mapping
 *
 * Note: This is a best-effort migration. Since UUIDs were runtime-generated,
 * we cannot automatically determine which UUID directories belong to which workspaces.
 */
export async function migrateUuidMemoryDirectories(
  options: {
    dryRun?: boolean;
    backup?: boolean;
    manualMapping?: Record<string, string>; // uuid -> workspace_id
  } = {},
): Promise<MemoryIdMigrationResult> {
  const result: MemoryIdMigrationResult = {
    success: false,
    migratedDirectories: [],
    errors: [],
    warnings: [],
  };

  try {
    // Get workspace registry
    const registry = await createRegistryStorage(StorageConfigs.defaultKV());
    await registry.initialize();

    // Get all registered workspaces (these have human-readable IDs)
    const workspaces = await registry.listWorkspaces();
    result.warnings.push(
      `Found ${workspaces.length} registered workspaces with human-readable IDs`,
    );

    // Get all UUID memory directories
    const uuidDirs = await listUuidMemoryDirectories();
    result.warnings.push(`Found ${uuidDirs.length} UUID-named memory directories`);

    if (uuidDirs.length === 0) {
      result.warnings.push("No UUID memory directories found - migration not needed");
      result.success = true;
      return result;
    }

    if (options.dryRun) {
      result.warnings.push("DRY RUN MODE - No directories will actually be moved");
    }

    const memoryDir = getAtlasMemoryDir();

    // If manual mapping provided, use it
    if (options.manualMapping) {
      for (const [uuidDir, workspaceId] of Object.entries(options.manualMapping)) {
        if (!uuidDirs.includes(uuidDir)) {
          result.warnings.push(`UUID directory ${uuidDir} not found, skipping`);
          continue;
        }

        const workspace = workspaces.find((w) => w.id === workspaceId);
        if (!workspace) {
          result.errors.push(`Workspace ID ${workspaceId} not found in registry`);
          continue;
        }

        const oldPath = join(memoryDir, uuidDir);
        const newPath = join(memoryDir, workspaceId);

        // Check if target already exists
        if (await exists(newPath)) {
          result.errors.push(`Target directory already exists: ${workspaceId}`);
          continue;
        }

        if (options.backup && !options.dryRun) {
          // Create backup
          const backupPath = `${oldPath}.backup.${Date.now()}`;
          await Deno.rename(oldPath, backupPath);
          result.warnings.push(`Backup created: ${backupPath}`);

          // Copy back for the actual move
          await Deno.rename(backupPath, oldPath);
        }

        if (!options.dryRun) {
          await move(oldPath, newPath);
        }

        result.migratedDirectories.push({
          oldPath: uuidDir,
          newPath: workspaceId,
          workspaceName: workspace.name,
        });
      }
    } else {
      // No manual mapping - provide guidance
      result.warnings.push(
        "No manual mapping provided. Cannot automatically map UUID directories to workspaces.",
      );
      result.warnings.push(
        "Use the manual mapping option to specify which UUID directories belong to which workspaces:",
      );
      result.warnings.push(
        "Example: { '264f0130-6cfd-443e-b802-e4cb9a731203': 'delicate_waffle' }",
      );

      result.warnings.push("\nRegistered workspaces:");
      for (const workspace of workspaces) {
        result.warnings.push(`  ${workspace.id} - ${workspace.name} (${workspace.path})`);
      }

      result.warnings.push("\nUUID memory directories:");
      for (const uuidDir of uuidDirs) {
        result.warnings.push(`  ${uuidDir}`);
      }
    }

    if (result.migratedDirectories.length > 0) {
      result.success = true;
      result.warnings.push(
        `Successfully migrated ${result.migratedDirectories.length} memory directories to human-readable names`,
      );
    } else if (options.manualMapping && Object.keys(options.manualMapping).length > 0) {
      result.warnings.push("No directories were migrated - check errors above");
    }
  } catch (error) {
    result.errors.push(
      `Migration failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return result;
}

/**
 * Clean up empty UUID directories (after successful migration)
 */
export async function cleanupEmptyUuidDirectories(): Promise<string[]> {
  const uuidDirs = await listUuidMemoryDirectories();
  const removedDirs: string[] = [];
  const memoryDir = getAtlasMemoryDir();

  for (const uuidDir of uuidDirs) {
    const dirPath = join(memoryDir, uuidDir);

    try {
      let hasFiles = false;
      for await (const _entry of Deno.readDir(dirPath)) {
        hasFiles = true;
        break;
      }

      if (!hasFiles) {
        await Deno.remove(dirPath);
        removedDirs.push(uuidDir);
      }
    } catch {
      // Directory might not exist or be accessible
    }
  }

  return removedDirs;
}

/**
 * Check if a string matches UUID format
 */
function isUuidFormat(str: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return uuidRegex.test(str);
}

/**
 * Get memory usage statistics, separated by UUID vs human-readable directories
 */
export async function getMemoryDirectoryStats(): Promise<{
  humanReadable: Array<{ name: string; files: number; sizeBytes: number }>;
  uuid: Array<{ name: string; files: number; sizeBytes: number }>;
  cache: { files: number; sizeBytes: number } | null;
}> {
  const memoryDir = getAtlasMemoryDir();
  const stats = { humanReadable: [], uuid: [], cache: null };

  try {
    for await (const entry of Deno.readDir(memoryDir)) {
      if (entry.isDirectory) {
        const dirPath = join(memoryDir, entry.name);
        let files = 0;
        let sizeBytes = 0;

        try {
          for await (const subEntry of Deno.readDir(dirPath)) {
            if (subEntry.isFile) {
              files++;
              try {
                const stat = await Deno.stat(join(dirPath, subEntry.name));
                sizeBytes += stat.size;
              } catch {
                // Ignore stat errors
              }
            }
          }
        } catch {
          // Directory might not be accessible
        }

        if (entry.name === ".cache") {
          stats.cache = { files, sizeBytes };
        } else if (isUuidFormat(entry.name)) {
          stats.uuid.push({ name: entry.name, files, sizeBytes });
        } else {
          stats.humanReadable.push({ name: entry.name, files, sizeBytes });
        }
      }
    }
  } catch {
    // Memory directory might not exist
  }

  return stats;
}
