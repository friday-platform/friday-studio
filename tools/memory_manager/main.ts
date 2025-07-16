#!/usr/bin/env deno run --allow-read --allow-write --unstable

/**
 * Atlas Memory Manager
 *
 * A command-line tool for navigating and managing Atlas workspace memory
 *
 * Usage:
 *   deno run --allow-read --allow-write --unstable tools/memory_manager/main.ts [workspace-path]
 */

import { parseArgs } from "@std/cli";
import { join as _join } from "@std/path";
import { AtlasMemoryLoader } from "./utils/memory-loader.ts";
import { AtlasMemoryOperations } from "./utils/memory-operations.ts";
import { MemoryManagerTUI } from "./src/tui.ts";

interface Args {
  help?: boolean;
  stats?: boolean;
  export?: boolean;
  import?: boolean;
  validate?: boolean;
  workspace?: string;
  _: (string | number)[];
}

async function main() {
  const args = parseArgs(Deno.args, {
    string: ["workspace"],
    boolean: ["help", "stats", "export", "import", "validate"],
    alias: {
      w: "workspace",
      h: "help",
      s: "stats",
      e: "export",
      i: "import",
      v: "validate",
    },
  }) as Args;

  if (args.help) {
    showHelp();
    return;
  }

  // Get workspace path from args or use current directory
  const workspacePath = args.workspace || args._[0]?.toString() || Deno.cwd();

  console.log(`Atlas Memory Manager`);
  console.log(`Workspace: ${workspacePath}`);
  console.log(`Loading memory data...`);

  try {
    // Initialize memory loader and operations
    const loader = new AtlasMemoryLoader(workspacePath);
    const operations = new AtlasMemoryOperations(loader);

    await operations.initialize();

    // Handle different modes
    if (args.stats) {
      await showStats(operations, loader);
      return;
    }

    if (args.export) {
      await exportMemory(operations);
      return;
    }

    if (args.validate) {
      await validateMemory(operations);
      return;
    }

    // Default: Start TUI
    console.log(`Starting interactive memory manager...`);
    console.log(`Press 'h' for help, 'q' to quit`);

    // Small delay to let user read the message
    await new Promise((resolve) => setTimeout(resolve, 1000));

    const tui = new MemoryManagerTUI(operations);
    await tui.start();
  } catch (error) {
    console.error(
      `Error: ${error instanceof Error ? error.message : String(error)}`,
    );
    Deno.exit(1);
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
    ↑/↓ or j/k              Navigate up/down in memory list
    Enter                    View selected memory entry details
    e                        Edit selected entry (future feature)
    n                        Create new entry (future feature)
    d                        Delete selected entry (future feature)
    /                        Search in current memory type
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

async function showStats(
  operations: AtlasMemoryOperations,
  loader: AtlasMemoryLoader,
) {
  console.log(`\nMemory Statistics:`);
  console.log(`─────────────────`);

  const stats = operations.getStats();
  const storageStats = await loader.getStorageStats();

  console.log(`Storage Path: ${storageStats.path}`);
  console.log();

  for (const [memoryType, typeStats] of Object.entries(stats)) {
    const storageInfo = storageStats.memoryTypes[
      memoryType as keyof typeof storageStats.memoryTypes
    ];

    console.log(`${memoryType.toUpperCase()} Memory:`);
    console.log(`  Entries: ${typeStats.count}`);
    console.log(`  Avg Relevance: ${typeStats.avgRelevance.toFixed(2)}`);
    console.log(
      `  File Size: ${storageInfo?.size ? Math.round(storageInfo.size / 1024) + " KB" : "N/A"}`,
    );
    console.log(
      `  Last Modified: ${storageInfo?.lastModified?.toLocaleString() || "Never"}`,
    );

    if (typeStats.mostRecent) {
      console.log(`  Most Recent: ${typeStats.mostRecent.toLocaleString()}`);
    }
    if (typeStats.oldestEntry) {
      console.log(`  Oldest Entry: ${typeStats.oldestEntry.toLocaleString()}`);
    }
    console.log();
  }

  const totalEntries = Object.values(stats).reduce(
    (sum, s) => sum + s.count,
    0,
  );
  console.log(`Total Entries: ${totalEntries}`);
}

async function exportMemory(operations: AtlasMemoryOperations) {
  const jsonData = await operations.exportToJson();
  console.log(jsonData);
}

function validateMemory(operations: AtlasMemoryOperations) {
  console.log(`\nValidating Memory Data:`);
  console.log(`──────────────────────`);

  let totalErrors = 0;
  const allData = operations.getAll();

  for (const [memoryType, entries] of Object.entries(allData)) {
    console.log(`\nValidating ${memoryType.toUpperCase()} memory...`);

    let typeErrors = 0;
    for (const [key, entry] of Object.entries(entries)) {
      const errors = operations.validateEntry(entry);
      if (errors.length > 0) {
        console.log(`  ❌ ${key}: ${errors.join(", ")}`);
        typeErrors += errors.length;
      }
    }

    if (typeErrors === 0) {
      console.log(
        `  ✅ ${Object.keys(entries).length} entries validated successfully`,
      );
    } else {
      console.log(`  ❌ ${typeErrors} validation errors found`);
    }

    totalErrors += typeErrors;
  }

  console.log(
    `\n${totalErrors === 0 ? "✅" : "❌"} Validation complete: ${totalErrors} total errors`,
  );

  if (totalErrors > 0) {
    Deno.exit(1);
  }
}

if (import.meta.main) {
  await main();
}
