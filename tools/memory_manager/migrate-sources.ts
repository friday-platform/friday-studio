#!/usr/bin/env -S deno run --allow-all

/**
 * Memory Source Migration Script
 *
 * This script migrates existing memory entries to include source information.
 * It adds default source values for backward compatibility with the new
 * PII-safe memory system.
 */

import { join } from "@std/path";
import { exists } from "@std/fs";
import { MemorySource } from "../../packages/memory/src/mecmf-interfaces.ts";
import { CoALAMemoryManager } from "../../packages/memory/src/coala-memory.ts";
import { VectorSearchLocalStorageAdapter } from "@atlas/storage";

interface MigrationOptions {
  workspacePath: string;
  dryRun?: boolean;
  verbose?: boolean;
}

interface MigrationStats {
  totalMemories: number;
  memoriesMigrated: number;
  memoriesSkipped: number;
  errors: Array<{ id: string; error: string }>;
}

export class MemorySourceMigrator {
  private stats: MigrationStats = {
    totalMemories: 0,
    memoriesMigrated: 0,
    memoriesSkipped: 0,
    errors: [],
  };

  async migrate(options: MigrationOptions): Promise<MigrationStats> {
    const { workspacePath, dryRun = false, verbose = false } = options;

    console.log(`🔄 Starting memory source migration for: ${workspacePath}`);
    console.log(`📝 Dry run: ${dryRun ? "Yes" : "No"}`);
    console.log("");

    // Check if workspace exists
    if (!await exists(workspacePath)) {
      throw new Error(`Workspace path does not exist: ${workspacePath}`);
    }

    // Initialize memory manager for the workspace
    const memoryDir = join(workspacePath, ".atlas", "memory");
    const vectorDir = join(workspacePath, ".atlas", "vectors");

    if (!await exists(memoryDir)) {
      console.log("⚠️  No memory directory found - nothing to migrate");
      return this.stats;
    }

    const scope = {
      id: workspacePath,
      workspaceId: workspacePath,
      type: "workspace" as const,
    };

    const memoryManager = new CoALAMemoryManager(scope);

    try {
      // Get all existing memories
      const memories = memoryManager.getAllMemories();
      this.stats.totalMemories = memories.length;

      console.log(`📊 Found ${memories.length} memory entries to process`);
      console.log("");

      for (const memory of memories) {
        try {
          // Check if memory already has source information
          if (memory.source) {
            this.stats.memoriesSkipped++;
            if (verbose) {
              console.log(`⏭️  Skipping ${memory.id} (already has source: ${memory.source})`);
            }
            continue;
          }

          // Determine appropriate default source based on memory content and tags
          const defaultSource = this.determineDefaultSource(memory);
          const defaultSourceMetadata = this.createDefaultSourceMetadata(memory);

          if (verbose) {
            console.log(`🔧 Migrating ${memory.id} -> ${defaultSource}`);
          }

          if (!dryRun) {
            // Update the memory entry with source information
            memory.source = defaultSource;
            memory.sourceMetadata = defaultSourceMetadata;

            // Store the updated memory back to the manager
            memoryManager.rememberWithMetadata(memory.id, memory.content, {
              memoryType: memory.memoryType,
              tags: memory.tags,
              relevanceScore: memory.relevanceScore,
              confidence: memory.confidence,
              decayRate: memory.decayRate,
              associations: memory.associations,
              source: defaultSource,
              sourceMetadata: defaultSourceMetadata,
            });
          }

          this.stats.memoriesMigrated++;
        } catch (error) {
          this.stats.errors.push({
            id: memory.id,
            error: error instanceof Error ? error.message : String(error),
          });

          if (verbose) {
            console.error(`❌ Error migrating ${memory.id}:`, error);
          }
        }
      }

      // Print summary
      console.log("📈 Migration Summary:");
      console.log(`   Total memories: ${this.stats.totalMemories}`);
      console.log(`   Migrated: ${this.stats.memoriesMigrated}`);
      console.log(`   Skipped: ${this.stats.memoriesSkipped}`);
      console.log(`   Errors: ${this.stats.errors.length}`);

      if (this.stats.errors.length > 0) {
        console.log("");
        console.log("❌ Errors encountered:");
        for (const error of this.stats.errors) {
          console.log(`   ${error.id}: ${error.error}`);
        }
      }

      if (dryRun) {
        console.log("");
        console.log("🏃‍♂️ Dry run completed - no changes made");
      } else {
        console.log("");
        console.log("✅ Migration completed successfully");
      }
    } finally {
      await memoryManager.dispose();
    }

    return this.stats;
  }

  private determineDefaultSource(memory: any): string {
    // Logic to determine appropriate default source based on memory characteristics

    // Check tags for clues about the source
    const tags = memory.tags || [];

    // Agent-related memories
    if (tags.some((tag: string) => tag.includes("agent") || tag === "execution")) {
      return MemorySource.AGENT_OUTPUT;
    }

    // User input memories (less common in existing data, but possible)
    if (tags.some((tag: string) => tag.includes("user") || tag.includes("input"))) {
      return MemorySource.USER_INPUT;
    }

    // Tool output memories
    if (tags.some((tag: string) => tag.includes("tool") || tag.includes("mcp"))) {
      return MemorySource.TOOL_OUTPUT;
    }

    // System-generated memories (rules, procedures, etc.)
    if (
      tags.some((tag: string) =>
        tag.includes("rule") ||
        tag.includes("procedural") ||
        tag.includes("system") ||
        tag === "workspace" ||
        tag === "initialization"
      )
    ) {
      return MemorySource.SYSTEM_GENERATED;
    }

    // Check memory type for additional clues
    if (memory.memoryType === "PROCEDURAL") {
      return MemorySource.SYSTEM_GENERATED;
    }

    // Default to SYSTEM_GENERATED for safety (most restrictive for PII)
    return MemorySource.SYSTEM_GENERATED;
  }

  private createDefaultSourceMetadata(memory: any): Record<string, string> | undefined {
    const metadata: Record<string, string> = {};

    // Extract workspace ID if available
    if (memory.sourceScope) {
      metadata.workspaceId = memory.sourceScope;
    }

    // Try to extract session ID from tags or content
    const tags = memory.tags || [];
    const sessionTag = tags.find((tag: string) => tag.startsWith("session-"));
    if (sessionTag) {
      metadata.sessionId = sessionTag.replace("session-", "");
    }

    // Try to extract agent ID from tags
    const agentTag = tags.find((tag: string) =>
      tag.startsWith("agent-") && !tag.includes("result")
    );
    if (agentTag) {
      metadata.agentId = agentTag.replace("agent-", "");
    }

    return Object.keys(metadata).length > 0 ? metadata : undefined;
  }

  getStats(): MigrationStats {
    return { ...this.stats };
  }
}

// CLI interface
if (import.meta.main) {
  const args = Deno.args;

  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    console.log(`
Memory Source Migration Tool

Usage: deno run --allow-all migrate-sources.ts <workspace-path> [options]

Arguments:
  workspace-path    Path to the workspace to migrate

Options:
  --dry-run        Preview changes without modifying data
  --verbose        Show detailed migration progress
  --help, -h       Show this help message

Examples:
  # Preview migration for a workspace
  deno run --allow-all migrate-sources.ts /path/to/workspace --dry-run --verbose

  # Perform actual migration
  deno run --allow-all migrate-sources.ts /path/to/workspace

  # Migrate all workspaces in a directory
  for dir in /workspaces/*; do
    deno run --allow-all migrate-sources.ts "$dir"
  done
`);
    Deno.exit(0);
  }

  const workspacePath = args[0];
  const dryRun = args.includes("--dry-run");
  const verbose = args.includes("--verbose");

  try {
    const migrator = new MemorySourceMigrator();
    await migrator.migrate({
      workspacePath,
      dryRun,
      verbose,
    });
  } catch (error) {
    console.error("Migration failed:", error);
    Deno.exit(1);
  }
}
