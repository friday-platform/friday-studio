/**
 * Memory Migration Utility
 *
 * Helps migrate from global memory storage (~/.atlas/memory/*.json)
 * to workspace-specific storage (~/.atlas/memory/{workspace}/*)
 */

import { join } from "@std/path";
import { ensureDir, exists, move } from "@std/fs";
import { getAtlasMemoryDir, getWorkspaceMemoryDir } from "./paths.ts";

export interface MigrationResult {
  success: boolean;
  migratedFiles: string[];
  errors: string[];
  warnings: string[];
}

/**
 * Check if migration is needed (old global memory files exist)
 */
export async function needsMigration(): Promise<boolean> {
  const memoryDir = getAtlasMemoryDir();

  // Check for old global memory files
  const oldFiles = [
    "working.json",
    "episodic.json",
    "semantic.json",
    "procedural.json",
    "contextual.json",
    "index.json",
  ];

  for (const file of oldFiles) {
    const filePath = join(memoryDir, file);
    if (await exists(filePath)) {
      return true;
    }
  }

  return false;
}

/**
 * Migrate global memory files to workspace-specific storage
 *
 * @param workspaceId - The workspace ID to migrate memories to (usually the current workspace)
 * @param options - Migration options
 */
export async function migrateGlobalMemoriesToWorkspace(
  workspaceId: string,
  options: {
    backup?: boolean;
    dryRun?: boolean;
  } = {},
): Promise<MigrationResult> {
  const result: MigrationResult = {
    success: false,
    migratedFiles: [],
    errors: [],
    warnings: [],
  };

  try {
    const memoryDir = getAtlasMemoryDir();
    const workspaceMemoryDir = getWorkspaceMemoryDir(workspaceId);

    if (options.dryRun) {
      result.warnings.push("DRY RUN MODE - No files will actually be moved");
    }

    // Files to migrate
    const filesToMigrate = [
      "working.json",
      "episodic.json",
      "semantic.json",
      "procedural.json",
      "contextual.json",
      "index.json",
    ];

    // Directories to migrate
    const dirsToMigrate = [
      "vectors",
      "knowledge-graph",
    ];

    // Ensure workspace memory directory exists
    if (!options.dryRun) {
      await ensureDir(workspaceMemoryDir);
    }

    // Migrate files
    for (const filename of filesToMigrate) {
      const oldPath = join(memoryDir, filename);
      const newPath = join(workspaceMemoryDir, filename);

      if (await exists(oldPath)) {
        if (options.backup && !options.dryRun) {
          // Create backup
          const backupPath = `${oldPath}.backup.${Date.now()}`;
          await Deno.copyFile(oldPath, backupPath);
          result.warnings.push(`Backup created: ${backupPath}`);
        }

        if (!options.dryRun) {
          await move(oldPath, newPath);
        }

        result.migratedFiles.push(`${filename} -> ${workspaceId}/${filename}`);
      }
    }

    // Migrate directories
    for (const dirname of dirsToMigrate) {
      const oldDir = join(memoryDir, dirname);
      const newDir = join(workspaceMemoryDir, dirname);

      if (await exists(oldDir)) {
        if (options.backup && !options.dryRun) {
          // Create backup directory
          const backupDir = `${oldDir}.backup.${Date.now()}`;
          await Deno.rename(oldDir, backupDir);
          result.warnings.push(`Backup directory created: ${backupDir}`);
        }

        if (!options.dryRun) {
          await move(oldDir, newDir);
        }

        result.migratedFiles.push(`${dirname}/ -> ${workspaceId}/${dirname}/`);
      }
    }

    if (result.migratedFiles.length > 0) {
      result.success = true;
      result.warnings.push(
        `Migration completed for workspace: ${workspaceId}. ` +
          `Files moved from global memory to workspace-specific storage.`,
      );
    } else {
      result.warnings.push(
        "No files found to migrate - you may already be using workspace-specific storage.",
      );
    }
  } catch (error) {
    result.errors.push(
      `Migration failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return result;
}

/**
 * List all workspace memory directories
 */
export async function listWorkspaceMemoryDirectories(): Promise<string[]> {
  const memoryDir = getAtlasMemoryDir();
  const workspaces: string[] = [];

  try {
    for await (const entry of Deno.readDir(memoryDir)) {
      if (entry.isDirectory && !entry.name.startsWith(".")) {
        // Skip old global directories
        if (!["vectors", "knowledge-graph"].includes(entry.name)) {
          workspaces.push(entry.name);
        }
      }
    }
  } catch (error) {
    // Memory directory might not exist yet
  }

  return workspaces;
}

/**
 * Get memory usage statistics for all workspaces
 */
export async function getMemoryUsageStats(): Promise<{
  totalWorkspaces: number;
  workspaceStats: Array<{
    workspaceId: string;
    memoryFiles: number;
    totalSizeBytes: number;
    hasVectorIndex: boolean;
    hasKnowledgeGraph: boolean;
  }>;
}> {
  const workspaces = await listWorkspaceMemoryDirectories();
  const workspaceStats = [];

  for (const workspaceId of workspaces) {
    const workspaceDir = getWorkspaceMemoryDir(workspaceId);
    let memoryFiles = 0;
    let totalSizeBytes = 0;
    let hasVectorIndex = false;
    let hasKnowledgeGraph = false;

    try {
      for await (const entry of Deno.readDir(workspaceDir)) {
        if (entry.isFile && entry.name.endsWith(".json")) {
          memoryFiles++;
          try {
            const filePath = join(workspaceDir, entry.name);
            const stat = await Deno.stat(filePath);
            totalSizeBytes += stat.size;
          } catch {
            // Ignore stat errors
          }
        } else if (entry.isDirectory) {
          if (entry.name === "vectors") hasVectorIndex = true;
          if (entry.name === "knowledge-graph") hasKnowledgeGraph = true;
        }
      }
    } catch {
      // Directory might not be accessible
    }

    workspaceStats.push({
      workspaceId,
      memoryFiles,
      totalSizeBytes,
      hasVectorIndex,
      hasKnowledgeGraph,
    });
  }

  return {
    totalWorkspaces: workspaces.length,
    workspaceStats,
  };
}

/**
 * Clean up empty workspace memory directories
 */
export async function cleanupEmptyWorkspaceDirectories(): Promise<string[]> {
  const workspaces = await listWorkspaceMemoryDirectories();
  const removedDirectories = [];

  for (const workspaceId of workspaces) {
    const workspaceDir = getWorkspaceMemoryDir(workspaceId);

    try {
      let hasFiles = false;
      for await (const _entry of Deno.readDir(workspaceDir)) {
        hasFiles = true;
        break;
      }

      if (!hasFiles) {
        await Deno.remove(workspaceDir);
        removedDirectories.push(workspaceId);
      }
    } catch {
      // Directory might not exist or be accessible
    }
  }

  return removedDirectories;
}
