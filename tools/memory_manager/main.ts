#!/usr/bin/env deno run --allow-read --allow-write --unstable

/**
 * Atlas Memory Manager
 *
 * A command-line tool for navigating and managing Atlas workspace memory
 *
 * Usage:
 *   deno run --allow-read --allow-write --unstable tools/memory_manager/main.ts [workspace-path]
 */

import process from "node:process";
import type { CoALAMemoryEntry, CoALAMemoryManager } from "@atlas/memory";
import { type CoALAMemoryType, MEMORY_TYPES } from "@atlas/memory";
import type { WorkspaceEntry } from "@atlas/workspace";
import { parseArgs } from "@std/cli";
import { MemoryManagerTUI } from "./src/tui.ts";
import { AtlasMemoryLoader } from "./utils/memory-loader.ts";

interface Args {
  help?: boolean;
  stats?: boolean;
  import?: boolean;
  validate?: boolean;
  workspace?: string;
  _: (string | number)[];
}

async function main() {
  const args = parseArgs(Deno.args, {
    string: ["workspace"],
    boolean: ["help", "stats", "export", "import", "validate"],
    alias: { w: "workspace", h: "help", s: "stats", e: "export", i: "import", v: "validate" },
  }) as Args;

  if (args.help) {
    showHelp();
    return;
  }

  // Get workspace path from args
  let workspacePath = args.workspace || args._[0]?.toString();
  let selectedWorkspace: WorkspaceEntry | null = null;

  // If no workspace path provided and we're in interactive mode (not stats/export/validate),
  // show workspace selector
  const isInteractiveMode = !args.stats && !args.validate;

  if (!workspacePath && isInteractiveMode) {
    // Start TUI in workspace selector mode
    console.log(`Atlas Memory Manager - Workspace Selection`);
    console.log(`Loading available workspaces...`);

    // Small delay to let user read the message
    await new Promise((resolve) => setTimeout(resolve, 500));

    try {
      const tui = new MemoryManagerTUI();
      selectedWorkspace = await tui.selectWorkspace();

      if (!selectedWorkspace) {
        console.log("No workspace selected. Exiting...");
        return;
      }

      workspacePath = selectedWorkspace.path;
    } catch (error) {
      console.error(
        `Error in workspace selection: ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exit(1);
    }
  } else if (!workspacePath) {
    // For non-interactive modes, fall back to current directory
    workspacePath = Deno.cwd();
  }

  console.log(`Atlas Memory Manager`);
  console.log(`Workspace: ${workspacePath}`);
  console.log(`Loading memory data...`);

  try {
    // Initialize memory loader and operations
    let workspaceId: string | undefined;

    // If we have a selected workspace object, use its ID
    if (typeof selectedWorkspace !== "undefined" && selectedWorkspace) {
      workspaceId = selectedWorkspace.id;
    }

    const loader = workspaceId
      ? new AtlasMemoryLoader(workspacePath, workspaceId)
      : new AtlasMemoryLoader(workspacePath);
    const coalaManager = await loader.getCoALAManagerPublic();

    // Handle different modes
    if (args.stats) {
      await showStats(coalaManager, loader);
      return;
    }

    if (args.validate) {
      validateMemory(coalaManager);
      return;
    }

    // Default: Start TUI
    console.log(`Starting interactive memory manager...`);
    console.log(`Press 'h' for help, 'q' to quit`);

    // Small delay to let user read the message
    await new Promise((resolve) => setTimeout(resolve, 1000));

    const tui = new MemoryManagerTUI(coalaManager);
    await tui.start();
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

function showHelp() {
  console.log(`
Atlas Memory Manager - Navigate and manage workspace memory

USAGE:
    deno run --allow-read --allow-write --unstable tools/memory_manager/main.ts [OPTIONS] [WORKSPACE_PATH]

OPTIONS:
    -w, --workspace <PATH>    Specify workspace path (default: current directory)
    -s, --stats              Show memory statistics and exit
    -e, --export             Export all memory to JSON and exit
    -v, --validate           Validate memory data integrity and exit
    -h, --help               Show this help message

INTERACTIVE COMMANDS:
    Tab / Shift+Tab          Switch between memory types (Working, Episodic, Semantic, Procedural)
    ↑/↓ or j/k              Navigate up/down in memory list (arrow keys only in vector search mode)
    Enter                    View selected memory entry details
    e                        Edit selected entry (future feature)
    n                        Create new entry (future feature)
    d                        Delete selected entry (future feature)
    /                        Search in current memory type
    v                        Vector search mode (most keys used for typing during search)
    r                        Reload memory from disk
    s                        Save changes to disk
    h or ?                   Show/hide help
    q                        Quit

MEMORY TYPES:
    Working       Short-term, active processing memory
    Episodic      Specific experiences and events
    Semantic      General knowledge and concepts
    Procedural    How-to knowledge and skills

EXAMPLES:
    # Start interactive manager in current workspace
    deno run --allow-read --allow-write --unstable tools/memory_manager/main.ts

    # Show stats for specific workspace
    deno run --allow-read --allow-write --unstable tools/memory_manager/main.ts --stats --workspace ./my-workspace

    # Export memory data
    deno run --allow-read --allow-write --unstable tools/memory_manager/main.ts --export > memory-backup.json
`);
}

async function showStats(coalaManager: CoALAMemoryManager, loader: AtlasMemoryLoader) {
  console.log(`\nMemory Statistics:`);
  console.log(`─────────────────`);

  // Get stats using CoALA manager
  const stats: Record<
    CoALAMemoryType,
    { count: number; avgRelevance: number; mostRecent?: Date; oldestEntry?: Date }
  > = {
    working: { count: 0, avgRelevance: 0 },
    episodic: { count: 0, avgRelevance: 0 },
    semantic: { count: 0, avgRelevance: 0 },
    procedural: { count: 0, avgRelevance: 0 },
    contextual: { count: 0, avgRelevance: 0 },
  };

  for (const memoryType of MEMORY_TYPES) {
    const entries = coalaManager.getMemoriesByType(memoryType);
    const timestamps = entries.map((e) => e.timestamp);

    stats[memoryType] = {
      count: entries.length,
      avgRelevance:
        entries.length > 0
          ? entries.reduce((sum, e) => sum + e.relevanceScore, 0) / entries.length
          : 0,
      mostRecent:
        timestamps.length > 0
          ? new Date(Math.max(...timestamps.map((t) => t.getTime())))
          : undefined,
      oldestEntry:
        timestamps.length > 0
          ? new Date(Math.min(...timestamps.map((t) => t.getTime())))
          : undefined,
    };
  }

  const storageStats = await loader.getStorageStats();

  console.log(`Storage Path: ${storageStats.path}`);
  console.log();

  for (const memoryType of MEMORY_TYPES) {
    const typeStats = stats[memoryType];
    const storageInfo = storageStats.memoryTypes[memoryType];

    console.log(`${memoryType.toUpperCase()} Memory:`);
    console.log(`  Entries: ${typeStats.count}`);
    console.log(`  Avg Relevance: ${typeStats.avgRelevance.toFixed(2)}`);
    console.log(
      `  File Size: ${storageInfo?.size ? `${Math.round(storageInfo.size / 1024)} KB` : "N/A"}`,
    );
    console.log(`  Last Modified: ${storageInfo?.lastModified?.toLocaleString() || "Never"}`);

    if (typeStats.mostRecent) {
      console.log(`  Most Recent: ${typeStats.mostRecent.toLocaleString()}`);
    }
    if (typeStats.oldestEntry) {
      console.log(`  Oldest Entry: ${typeStats.oldestEntry.toLocaleString()}`);
    }
    console.log();
  }

  const totalEntries = Object.values(stats).reduce((sum, s) => sum + s.count, 0);
  console.log(`Total Entries: ${totalEntries}`);
}

function validateMemory(coalaManager: CoALAMemoryManager) {
  console.log(`\nValidating Memory Data:`);
  console.log(`──────────────────────`);

  let totalErrors = 0;

  function validateEntry(entry: CoALAMemoryEntry): string[] {
    const errors: string[] = [];

    if (typeof entry !== "object" || entry === null) {
      errors.push("Entry must be an object");
      return errors;
    }

    const entryObj = entry;

    if (!entryObj.id || typeof entryObj.id !== "string" || entryObj.id.trim() === "") {
      errors.push("ID is required");
    }

    if (entryObj.content === undefined || entryObj.content === null) {
      errors.push("Content is required");
    }

    if (
      entryObj.relevanceScore !== undefined &&
      (typeof entryObj.relevanceScore !== "number" ||
        entryObj.relevanceScore < 0 ||
        entryObj.relevanceScore > 1)
    ) {
      errors.push("Relevance score must be between 0 and 1");
    }

    if (
      entryObj.confidence !== undefined &&
      (typeof entryObj.confidence !== "number" ||
        entryObj.confidence < 0 ||
        entryObj.confidence > 1)
    ) {
      errors.push("Confidence must be between 0 and 1");
    }

    if (
      entryObj.decayRate !== undefined &&
      (typeof entryObj.decayRate !== "number" || entryObj.decayRate < 0)
    ) {
      errors.push("Decay rate must be non-negative");
    }

    return errors;
  }

  for (const memoryType of MEMORY_TYPES) {
    const entries = coalaManager.getMemoriesByType(memoryType);
    console.log(`\nValidating ${memoryType.toUpperCase()} memory...`);

    let typeErrors = 0;
    for (const entry of entries) {
      const errors = validateEntry(entry);
      if (errors.length > 0) {
        console.log(`  ❌ ${entry.id}: ${errors.join(", ")}`);
        typeErrors += errors.length;
      }
    }

    if (typeErrors === 0) {
      console.log(`  ✅ ${entries.length} entries validated successfully`);
    } else {
      console.log(`  ❌ ${typeErrors} validation errors found`);
    }

    totalErrors += typeErrors;
  }

  console.log(
    `\n${totalErrors === 0 ? "✅" : "❌"} Validation complete: ${totalErrors} total errors`,
  );

  if (totalErrors > 0) {
    process.exit(1);
  }
}

if (import.meta.main) {
  await main();
}
