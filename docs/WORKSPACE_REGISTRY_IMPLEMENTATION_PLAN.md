# Workspace Registry Implementation Plan

## Overview

This document outlines the plan to implement a centralized workspace registry that will become the
foundation for all workspace operations in Atlas. We'll refactor the existing CLI to use this
registry, which will later enable multi-workspace background process support.

## Current Status (December 2024)

### ✅ Phase 1: Core Registry Implementation - **100% COMPLETE**

- All registry types and schemas implemented with Zod validation
- Docker-style naming system fully functional
- WorkspaceRegistryManager with all core operations
- Lazy health checks with proper status transitions
- Auto-discovery and import of existing workspaces
- Removed problematic lockfile mechanism for better reliability

### 🚧 Phase 2: CLI Integration - **80% COMPLETE**

- ✅ workspace init - Fully integrated with registry
- ✅ workspace list - Shows all registered workspaces with status
- ✅ workspace serve - Accepts workspace ID/name, dynamic port assignment
- ✅ workspace remove - Removes workspaces from registry
- ⏳ workspace status - Command exists but needs implementation
- ⏳ workspace cleanup - Command exists but needs implementation
- ⏳ Session/log commands - Need workspace ID support

### Key Improvements Made

1. **Dynamic Port Assignment**: Prevents conflicts between multiple workspaces
2. **Status Tracking**: Fixed issues with 'stopping' and 'starting' states
3. **Non-blocking Server Start**: Added `startNonBlocking()` method to WorkspaceServer
4. **Enhanced Health Checks**: Now handles STARTING, RUNNING, and STOPPING states
5. **Simplified Locking**: Removed file-based locking in favor of atomic operations

## Key Design Decisions

1. **Zod v4 for Validation**: All registry data structures are validated using Zod schemas,
   providing runtime type safety and clear error messages.

2. **Docker-Style Naming**: Instead of UUIDs, workspaces get memorable names like `fervent_einstein`
   or `happy_turing`, combining adjectives with names of famous scientists and tech pioneers.

3. **File-Based Locking**: The lockfile (`registry.json.lock`) prevents concurrent modifications to
   the registry. When one process is writing, others either wait or fail fast, ensuring data
   integrity.

4. **Lazy Health Checks**: Process status is verified on-demand during read operations, avoiding the
   need for a separate monitoring daemon.

## Goals

1. Create a persistent workspace registry at `~/.atlas/registry.json`
2. Track all workspaces (path, config, status, metadata)
3. Refactor existing CLI commands to use the registry
4. Implement lazy health checks for accurate status reporting
5. Provide a solid foundation for future detached process support

## Phase 1: Core Registry Implementation

### 1.1 Registry Schema and Types with Zod Validation

Create `src/core/workspace-registry-types.ts`:

```typescript
import { z } from "zod";

// Zod schemas for validation
export const WorkspaceStatusSchema = z.enum([
  "stopped",
  "starting",
  "running",
  "stopping",
  "crashed",
  "unknown",
]);

export const WorkspaceMetadataSchema = z.object({
  atlasVersion: z.string().optional(),
  description: z.string().optional(),
  tags: z.array(z.string()).optional(),
  environment: z.string().optional(),
}).optional();

export const WorkspaceEntrySchema = z.object({
  // Identification
  id: z.string(), // Docker-style name (e.g., "fervent_einstein")
  name: z.string(), // Human-readable name

  // Location
  path: z.string(),
  configPath: z.string(),

  // Runtime state
  status: WorkspaceStatusSchema,
  pid: z.number().optional(),
  port: z.number().optional(),

  // Timestamps
  createdAt: z.string().datetime(),
  lastSeen: z.string().datetime(),
  startedAt: z.string().datetime().optional(),
  stoppedAt: z.string().datetime().optional(),

  // Metadata
  metadata: WorkspaceMetadataSchema,
});

export const WorkspaceRegistrySchema = z.object({
  version: z.string(),
  workspaces: z.array(WorkspaceEntrySchema),
  lastUpdated: z.string().datetime(),
});

// Type inference from schemas
export type WorkspaceStatus = z.infer<typeof WorkspaceStatusSchema>;
export type WorkspaceEntry = z.infer<typeof WorkspaceEntrySchema>;
export type WorkspaceRegistry = z.infer<typeof WorkspaceRegistrySchema>;

// Export enum for convenience
export const WorkspaceStatus = {
  STOPPED: "stopped",
  STARTING: "starting",
  RUNNING: "running",
  STOPPING: "stopping",
  CRASHED: "crashed",
  UNKNOWN: "unknown",
} as const;
```

### 1.2 Docker-Style Name Generator

Create `src/core/workspace-names.ts`:

```typescript
// Docker-style name generation inspired by moby/moby
// Combines adjectives + famous scientists/hackers

const adjectives = [
  "admiring",
  "adoring",
  "agitated",
  "amazing",
  "angry",
  "awesome",
  "beautiful",
  "blissful",
  "bold",
  "boring",
  "brave",
  "busy",
  "charming",
  "clever",
  "cool",
  "compassionate",
  "competent",
  "confident",
  "dazzling",
  "determined",
  "distracted",
  "dreamy",
  "eager",
  "ecstatic",
  "elastic",
  "elated",
  "elegant",
  "eloquent",
  "epic",
  "exciting",
  "fervent",
  "festive",
  "flamboyant",
  "focused",
  "friendly",
  "frosty",
  "funny",
  "gallant",
  "gifted",
  "goofy",
  "gracious",
  "great",
  "happy",
  "hardcore",
  "heuristic",
  "hopeful",
  "hungry",
  "infallible",
  "inspiring",
  "intelligent",
  "interesting",
  "jolly",
  "jovial",
  "keen",
  "kind",
  "laughing",
  "loving",
  "lucid",
  "magical",
  "mystifying",
  "modest",
  "musing",
  "naughty",
  "nervous",
  "nice",
  "nifty",
  "nostalgic",
  "objective",
  "optimistic",
  "peaceful",
  "pedantic",
  "pensive",
  "practical",
  "priceless",
  "quirky",
  "quizzical",
  "recursing",
  "relaxed",
  "reverent",
  "romantic",
  "sad",
  "serene",
  "sharp",
  "silly",
  "sleepy",
  "stoic",
  "strange",
  "stupefied",
  "suspicious",
  "sweet",
  "tender",
  "thirsty",
  "trusting",
  "unruffled",
  "upbeat",
  "vibrant",
  "vigilant",
  "vigorous",
  "wizardly",
  "wonderful",
  "xenodochial",
  "youthful",
  "zealous",
  "zen",
];

const names = [
  // Scientists and inventors
  "albattani",
  "allen",
  "almeida",
  "antonelli",
  "archimedes",
  "ardinghelli",
  "aryabhata",
  "austin",
  "babbage",
  "banach",
  "bardeen",
  "bartik",
  "bassi",
  "beaver",
  "bell",
  "benz",
  "bhabha",
  "bhaskara",
  "blackburn",
  "blackwell",
  "bohr",
  "booth",
  "borg",
  "bose",
  "boyd",
  "brahmagupta",
  "brattain",
  "brown",
  "carson",
  "chatelet",
  "chatterjee",
  "chebyshev",
  "cohen",
  "colden",
  "cori",
  "cray",
  "curie",
  "darwin",
  "davinci",
  "dewdney",
  "dhawan",
  "diffie",
  "dijkstra",
  "dirac",
  "driscoll",
  "dubinsky",
  "easley",
  "edison",
  "einstein",
  "elbakyan",
  "elgamal",
  "elion",
  "ellis",
  "engelbart",
  "euclid",
  "euler",
  "faraday",
  "feistel",
  "fermat",
  "fermi",
  "feynman",
  "franklin",
  "gagarin",
  "galileo",
  "galois",
  "ganguly",
  // Modern tech pioneers
  "gates",
  "gauss",
  "germain",
  "goldberg",
  "goldstine",
  "goldwasser",
  "golick",
  "goodall",
  "gould",
  "greider",
  "grothendieck",
  "haibt",
  "hamilton",
  "haslett",
  "hawking",
  "heisenberg",
  "hermann",
  "herschel",
  "hertz",
  "heyrovsky",
  "hodgkin",
  "hofstadter",
  "hoover",
  "hopper",
  "hugle",
  "hypatia",
  "ishizaka",
  "jackson",
  "jang",
  "jennings",
  "jepsen",
  "johnson",
  "joliot",
  "jones",
  "kalam",
  "kapitsa",
  "kare",
  "keldysh",
  "keller",
  "kepler",
  "kilby",
  "kirch",
  "knuth",
  "kowalevski",
  "lalande",
  "lamarr",
  "lamport",
  "leakey",
  "leavitt",
  "lederberg",
  "lehmann",
  "lewin",
  "lichterman",
  "liskov",
  "lovelace",
  "lumiere",
  "mahavira",
  "margulis",
  "matsumoto",
  "maxwell",
  "mayer",
  "mccarthy",
  "mcclintock",
  "mclaren",
  "mclean",
  "mcnulty",
  "mendel",
  "mendeleev",
  "meitner",
  "meninsky",
  "merkle",
  "mestorf",
  "mirzakhani",
  "montalcini",
  "moore",
  "morse",
  "murdock",
  "moser",
  "napier",
  "nash",
  "neumann",
  "newton",
  "nightingale",
  "nobel",
  "noether",
  "northcutt",
  "noyce",
  "panini",
  "pare",
  "pascal",
  "pasteur",
  "payne",
  "perlman",
  "pike",
  "poincare",
  "poitras",
  "proskuriakova",
  "ptolemy",
  "raman",
  "ramanujan",
  "ride",
  "ritchie",
  "rhodes",
  "robinson",
  "roentgen",
  "rosalind",
  "rubin",
  "saha",
  "sammet",
  "sanderson",
  "satoshi",
  "shamir",
  "shannon",
  "shaw",
  "shirley",
  "shockley",
  "shtern",
  "sinoussi",
  "snyder",
  "solomon",
  "spence",
  "stallman",
  "stonebraker",
  "sutherland",
  "swanson",
  "swartz",
  "swirles",
  "taussig",
  "tereshkova",
  "tesla",
  "tharp",
  "thompson",
  "torvalds",
  "tu",
  "turing",
  "varahamihira",
  "vaughan",
  "visvesvaraya",
  "volhard",
  "villani",
  "wescoff",
  "wilbur",
  "wiles",
  "williams",
  "williamson",
  "wilson",
  "wing",
  "wozniak",
  "wright",
  "wu",
  "yalow",
  "yonath",
  "zhukovsky",
];

export function generateWorkspaceName(): string {
  const adjective = adjectives[Math.floor(Math.random() * adjectives.length)];
  const name = names[Math.floor(Math.random() * names.length)];
  return `${adjective}_${name}`;
}

// Ensure uniqueness by checking against existing names
export function generateUniqueWorkspaceName(existingNames: Set<string>): string {
  let name: string;
  let attempts = 0;

  do {
    name = generateWorkspaceName();
    attempts++;

    // After 10 attempts, start adding numbers
    if (attempts > 10 && existingNames.has(name)) {
      name = `${name}_${Math.floor(Math.random() * 1000)}`;
    }
  } while (existingNames.has(name) && attempts < 100);

  return name;
}
```

### 1.3 Registry Manager Implementation

Create `src/core/workspace-registry.ts`:

```typescript
import { basename, join } from "@std/path";
import { ensureDir, exists } from "@std/fs";
import { z } from "zod";
import {
  WorkspaceEntry,
  WorkspaceEntrySchema,
  WorkspaceRegistry,
  WorkspaceRegistrySchema,
  WorkspaceStatus,
} from "./workspace-registry-types.ts";
import { generateUniqueWorkspaceName } from "./workspace-names.ts";

export class WorkspaceRegistryManager {
  private registryPath: string;
  private lockFile: string;
  private registry: WorkspaceRegistry | null = null;

  constructor() {
    const homeDir = Deno.env.get("HOME") || Deno.env.get("USERPROFILE") || Deno.cwd();
    const atlasDir = join(homeDir, ".atlas");
    this.registryPath = join(atlasDir, "registry.json");
    // Lockfile prevents concurrent registry modifications
    // When one process is writing, others wait or fail fast
    this.lockFile = `${this.registryPath}.lock`;
  }

  async initialize(): Promise<void> {
    // Ensure .atlas directory exists
    const atlasDir = join(this.registryPath, "..");
    await ensureDir(atlasDir);

    // Load or create registry
    if (await exists(this.registryPath)) {
      await this.load();
    } else {
      this.registry = {
        version: "1.0.0",
        workspaces: [],
        lastUpdated: new Date().toISOString(),
      };
      await this.save();
    }
  }

  private async load(): Promise<void> {
    const content = await Deno.readTextFile(this.registryPath);
    const data = JSON.parse(content);

    // Validate with Zod
    try {
      this.registry = WorkspaceRegistrySchema.parse(data);
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw new Error(`Invalid registry format: ${error.message}`);
      }
      throw error;
    }
  }

  private async save(): Promise<void> {
    if (!this.registry) throw new Error("Registry not initialized");

    this.registry.lastUpdated = new Date().toISOString();

    // Validate before saving
    const validatedRegistry = WorkspaceRegistrySchema.parse(this.registry);
    const content = JSON.stringify(validatedRegistry, null, 2);

    // Atomic write with temp file
    const tempPath = `${this.registryPath}.tmp`;
    await Deno.writeTextFile(tempPath, content);
    await Deno.rename(tempPath, this.registryPath);
  }

  private async acquireLock(): Promise<void> {
    // Simple file-based locking
    let attempts = 0;
    while (attempts < 50) { // 5 seconds max wait
      try {
        await Deno.writeTextFile(this.lockFile, Deno.pid.toString(), {
          createNew: true, // Fails if file exists
        });
        return;
      } catch {
        // Lock exists, wait and retry
        await new Promise((resolve) => setTimeout(resolve, 100));
        attempts++;
      }
    }
    throw new Error("Failed to acquire registry lock");
  }

  private async releaseLock(): Promise<void> {
    try {
      await Deno.remove(this.lockFile);
    } catch {
      // Ignore if lock already removed
    }
  }

  // Core operations
  async register(workspacePath: string, options?: {
    name?: string;
    description?: string;
    tags?: string[];
  }): Promise<WorkspaceEntry> {
    if (!this.registry) await this.initialize();

    await this.acquireLock();
    try {
      // Check if already registered
      const existing = await this.findByPath(workspacePath);
      if (existing) {
        return existing;
      }

      // Generate unique Docker-style ID
      const existingIds = new Set(this.registry!.workspaces.map((w) => w.id));
      const id = generateUniqueWorkspaceName(existingIds);

      // Create new entry
      const entry: WorkspaceEntry = {
        id,
        name: options?.name || basename(workspacePath),
        path: await Deno.realPath(workspacePath),
        configPath: join(workspacePath, "workspace.yml"),
        status: WorkspaceStatus.STOPPED,
        createdAt: new Date().toISOString(),
        lastSeen: new Date().toISOString(),
        metadata: {
          atlasVersion: Deno.version.deno,
          description: options?.description,
          tags: options?.tags,
        },
      };

      // Validate entry with Zod
      const validatedEntry = WorkspaceEntrySchema.parse(entry);

      this.registry!.workspaces.push(validatedEntry);
      await this.save();

      return validatedEntry;
    } finally {
      await this.releaseLock();
    }
  }

  async unregister(id: string): Promise<void> {
    if (!this.registry) await this.initialize();

    this.registry!.workspaces = this.registry!.workspaces.filter((w) => w.id !== id);
    await this.save();
  }

  async updateStatus(
    id: string,
    status: WorkspaceStatus,
    updates?: Partial<WorkspaceEntry>,
  ): Promise<void> {
    if (!this.registry) await this.initialize();

    const workspace = this.registry!.workspaces.find((w) => w.id === id);
    if (!workspace) {
      throw new Error(`Workspace ${id} not found`);
    }

    workspace.status = status;
    workspace.lastSeen = new Date().toISOString();

    // Apply additional updates
    if (updates) {
      Object.assign(workspace, updates);
    }

    // Update timestamps based on status
    if (status === WorkspaceStatus.RUNNING) {
      workspace.startedAt = new Date().toISOString();
    } else if ([WorkspaceStatus.STOPPED, WorkspaceStatus.CRASHED].includes(status)) {
      workspace.stoppedAt = new Date().toISOString();
      workspace.pid = undefined;
      workspace.port = undefined;
    }

    await this.save();
  }

  // Query operations with lazy health checks
  async findById(id: string): Promise<WorkspaceEntry | null> {
    if (!this.registry) await this.initialize();

    const workspace = this.registry!.workspaces.find((w) => w.id === id);
    return workspace ? await this.checkAndUpdateHealth(workspace) : null;
  }

  async findByName(name: string): Promise<WorkspaceEntry | null> {
    if (!this.registry) await this.initialize();

    const workspace = this.registry!.workspaces.find((w) => w.name === name);
    return workspace ? await this.checkAndUpdateHealth(workspace) : null;
  }

  async findByPath(path: string): Promise<WorkspaceEntry | null> {
    if (!this.registry) await this.initialize();

    const normalizedPath = await Deno.realPath(path).catch(() => path);
    const workspace = this.registry!.workspaces.find((w) => w.path === normalizedPath);
    return workspace ? await this.checkAndUpdateHealth(workspace) : null;
  }

  async listAll(): Promise<WorkspaceEntry[]> {
    if (!this.registry) await this.initialize();

    // Check health of all workspaces
    const workspaces = await Promise.all(
      this.registry!.workspaces.map((w) => this.checkAndUpdateHealth(w)),
    );

    return workspaces;
  }

  async getRunning(): Promise<WorkspaceEntry[]> {
    const all = await this.listAll();
    return all.filter((w) => w.status === WorkspaceStatus.RUNNING);
  }

  // Lazy health check - core of our approach
  private async checkAndUpdateHealth(workspace: WorkspaceEntry): Promise<WorkspaceEntry> {
    // Only check if status indicates it should be running
    if (workspace.status === WorkspaceStatus.RUNNING && workspace.pid) {
      try {
        // Check if process exists
        const isRunning = await this.isProcessRunning(workspace.pid);

        if (!isRunning) {
          // Process died - update status
          await this.updateStatus(workspace.id, WorkspaceStatus.CRASHED, {
            stoppedAt: new Date().toISOString(),
            pid: undefined,
            port: undefined,
          });
          workspace.status = WorkspaceStatus.CRASHED;
        }
      } catch (error) {
        // Error checking process - mark as unknown
        workspace.status = WorkspaceStatus.UNKNOWN;
      }
    }

    return workspace;
  }

  private async isProcessRunning(pid: number): Promise<boolean> {
    try {
      // Send signal 0 to check if process exists
      Deno.kill(pid, "SIGCONT");
      return true;
    } catch {
      return false;
    }
  }

  // Utility methods
  async getCurrentWorkspace(): Promise<WorkspaceEntry | null> {
    // Find workspace for current directory
    const cwd = Deno.cwd();
    return await this.findByPath(cwd);
  }

  async findOrRegister(path: string, options?: {
    name?: string;
    description?: string;
  }): Promise<WorkspaceEntry> {
    const existing = await this.findByPath(path);
    if (existing) return existing;

    return await this.register(path, options);
  }
}

// Global singleton instance
export const workspaceRegistry = new WorkspaceRegistryManager();
```

## Phase 2: CLI Integration

### 2.0 TypeScript/React Setup Note

**Important**: Due to Deno's current React type resolution issues, we need to:

1. **Add React types**: Import type definitions for React hooks
   ```typescript
   // At the top of React component files
   import type { FC, useEffect, useState } from "npm:@types/react";
   ```

2. **Run with --no-check flag**: Until Deno resolves npm type imports
   ```bash
   deno run --allow-all --no-check src/cli.tsx
   ```

3. **Alternative**: Use explicit type annotations
   ```typescript
   const [state, setState] = useState<State>({ status: "idle" });
   ```

### 2.1 Update Workspace Command

Modify `src/cli/commands/workspace.tsx` to use the registry:

```typescript
import { workspaceRegistry } from "../../core/workspace-registry.ts";

export const WorkspaceCommand = ({ subcommand, args, flags }: Props) => {
  const [state, setState] = useState<State>({ status: "idle" });

  useEffect(() => {
    (async () => {
      try {
        switch (subcommand) {
          case "init":
            await handleInit(args, flags);
            break;

          case "serve":
            await handleServe(flags);
            break;

          case "list":
            await handleList(flags);
            break;

          case "status":
            await handleStatus(args[0]);
            break;

          default:
            // Default to serve
            await handleServe(flags);
        }
      } catch (error) {
        setState({ status: "error", error: error.message });
      }
    })();
  }, []);

  async function handleInit(args: string[], flags: any) {
    const name = args[0] || basename(Deno.cwd());

    // Register workspace
    const workspace = await workspaceRegistry.register(Deno.cwd(), {
      name,
      description: flags.description,
    });

    setState({
      status: "success",
      message: `Workspace '${workspace.name}' initialized (ID: ${workspace.id})`,
    });
  }

  async function handleServe(flags: any) {
    // Register or find current workspace
    const workspace = await workspaceRegistry.findOrRegister(Deno.cwd());

    // Update status to starting
    await workspaceRegistry.updateStatus(workspace.id, WorkspaceStatus.STARTING, {
      port: flags.port || 8080,
      pid: Deno.pid,
    });

    // Start server (existing logic)
    const runtime = new WorkspaceRuntime(/* ... */);
    await runtime.start();

    // Update status to running
    await workspaceRegistry.updateStatus(workspace.id, WorkspaceStatus.RUNNING);
  }

  async function handleList(flags: any) {
    const workspaces = await workspaceRegistry.listAll();

    if (flags.json) {
      setState({ status: "success", data: workspaces });
    } else {
      // Format as table
      setState({ status: "success", workspaces });
    }
  }

  async function handleStatus(idOrName?: string) {
    let workspace;

    if (idOrName) {
      // Find by ID or name
      workspace = await workspaceRegistry.findById(idOrName) ||
        await workspaceRegistry.findByName(idOrName);
    } else {
      // Current workspace
      workspace = await workspaceRegistry.getCurrentWorkspace();
    }

    if (!workspace) {
      throw new Error("Workspace not found");
    }

    setState({ status: "success", workspace });
  }

  // Render based on state...
};
```

### 2.2 Add Registry Commands

Add new subcommands for registry management:

```bash
# Initialize workspace in registry
atlas workspace init [name]

# List all registered workspaces
atlas workspace list [--format json|table]

# Show workspace details
atlas workspace status [id|name]

# Remove workspace from registry
atlas workspace remove <id|name>

# Clean up stale entries
atlas workspace cleanup
```

### 2.3 Update Session and Log Commands

Modify other commands to use workspace IDs from the registry:

```typescript
// In logs command
export const LogsCommand = ({ sessionId, flags }: Props) => {
  useEffect(() => {
    (async () => {
      // If sessionId looks like a workspace ID/name, get the workspace
      const workspace = await workspaceRegistry.findById(sessionId) ||
        await workspaceRegistry.findByName(sessionId);

      if (workspace) {
        // Read workspace-specific logs
        const logPath = join(homeDir, ".atlas", "logs", "workspaces", `${workspace.id}.log`);
        // ... tail logs
      } else {
        // Assume it's a session ID
        // ... existing session log logic
      }
    })();
  }, []);
};
```

## Phase 3: Enhanced Features

### 3.1 Workspace Discovery

Add automatic workspace discovery for common patterns:

```typescript
async discoverWorkspaces(searchPath: string = Deno.env.get("HOME")!): Promise<string[]> {
  const workspaces: string[] = [];
  
  // Look for workspace.yml files
  for await (const entry of walk(searchPath, {
    match: [/workspace\.yml$/],
    skip: [/node_modules/, /\.git/, /\.atlas/],
    maxDepth: 5,
  })) {
    workspaces.push(dirname(entry.path));
  }
  
  return workspaces;
}
```

### 3.2 Registry Migration

Support importing existing workspaces:

```typescript
async importExistingWorkspaces(): Promise<number> {
  const discovered = await this.discoverWorkspaces();
  let imported = 0;
  
  for (const path of discovered) {
    const existing = await this.findByPath(path);
    if (!existing) {
      await this.register(path);
      imported++;
    }
  }
  
  return imported;
}
```

### 3.3 Registry Maintenance

Add cleanup and maintenance operations:

```typescript
async cleanup(): Promise<number> {
  let cleaned = 0;
  
  for (const workspace of this.registry!.workspaces) {
    // Check if workspace directory still exists
    const exists = await Deno.stat(workspace.path).catch(() => null);
    
    if (!exists) {
      await this.unregister(workspace.id);
      cleaned++;
    }
  }
  
  return cleaned;
}

async vacuum(): Promise<void> {
  // Remove old stopped workspaces
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 30); // 30 days
  
  this.registry!.workspaces = this.registry!.workspaces.filter(w => {
    if (w.status === WorkspaceStatus.STOPPED && w.stoppedAt) {
      return new Date(w.stoppedAt) > cutoff;
    }
    return true;
  });
  
  await this.save();
}
```

## Implementation Steps

### ✅ Step 1: Core Registry (COMPLETE)

1. ✅ Create registry types and interfaces
2. ✅ Implement WorkspaceRegistryManager
3. ✅ Add unit tests for registry operations
4. ✅ Test lazy health checks

### 🚧 Step 2: CLI Integration (IN PROGRESS - 80% Complete)

1. ✅ Update workspace init command
2. ✅ Add workspace list command
3. ⏳ Add workspace status command (needs implementation)
4. ✅ Update workspace serve to use registry
5. ✅ Test existing functionality with registry

### 🚧 Step 3: Enhanced Commands (IN PROGRESS - 50% Complete)

1. ✅ Add workspace remove command
2. ⏳ Add workspace cleanup command (needs implementation)
3. ⏳ Update logs command to support workspace IDs
4. ✅ Add registry import functionality (auto-import on init)

### ⏳ Step 4: Polish (NOT STARTED)

1. ⏳ Add proper error handling
2. ✅ Improve CLI output formatting (table view)
3. ⏳ Add progress indicators
4. ⏳ Write documentation

## Remaining Work

### High Priority

1. Implement `workspace status` command functionality
2. Implement `workspace cleanup` command functionality
3. Add workspace ID/name support to session and log commands

### Medium Priority

1. Add progress indicators for long operations
2. Improve error messages and handling
3. Add `--json` output format support to all commands

### Low Priority

1. Add workspace tagging/grouping support
2. Add workspace metrics tracking
3. Create comprehensive documentation

## Benefits

1. **Single Source of Truth**: All workspace information in one place
2. **Persistent State**: Workspace information survives restarts
3. **Better UX**: Users can list and manage all workspaces easily
4. **Foundation for Growth**: Registry enables future features like:
   - Detached process support
   - Workspace templates
   - Cross-workspace operations
   - Workspace sharing/export

## Migration Path

1. **Backward Compatible**: Existing commands continue to work
2. **Automatic Registration**: Workspaces auto-register on first use
3. **Discovery Tool**: Import existing workspaces with one command
4. **Clean Upgrade**: No breaking changes to existing workflows

## Testing Strategy

1. **Unit Tests**: Test registry operations in isolation
2. **Integration Tests**: Test CLI commands with registry
3. **Edge Cases**: Test concurrent access, missing workspaces, etc.
4. **Performance**: Ensure registry scales to hundreds of workspaces

## Phase 3.4: Workspace Logs Command

### Overview

Add a `workspace logs` command to the CLI that allows users to view and stream logs from workspace
log files. This will provide similar functionality to `kubectl logs` for Kubernetes pods.

### Command Interface

```bash
# View logs from a workspace
atlas workspace logs [workspace-id|name] [options]

# Options
--follow, -f              Follow log output (stream new logs as they're written)
--tail <lines>           Number of lines to show from the end of logs (default: 100)
--since <duration>       Only show logs newer than a relative duration (e.g., 5m, 2h, 1d)
--timestamps             Include timestamps in log output (default: true)
--no-timestamps          Hide timestamps from log output
--json                   Output logs in JSON format
--level <level>          Filter logs by level (error, warn, info, debug, trace)
--context <key=value>    Filter logs by context values (e.g., --context sessionId=abc123)
```

### Implementation Plan

#### 3.4.1 Create Workspace Logs Command Component

Create `src/cli/commands/workspace/logs.tsx`:

```typescript
import { Box, Text } from "ink";
import { useEffect, useState } from "react";
import { AtlasLogger } from "../../../utils/logger.ts";
import { getWorkspaceRegistry } from "../../../core/workspace-registry.ts";

interface WorkspaceLogsCommandProps {
  args: string[];
  flags: {
    follow?: boolean;
    tail?: number;
    since?: string;
    timestamps?: boolean;
    json?: boolean;
    level?: string;
    context?: string[];
  };
}

export function WorkspaceLogsCommand({ args, flags }: WorkspaceLogsCommandProps) {
  const [logs, setLogs] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [streaming, setStreaming] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const workspaceIdOrName = args[0];
        if (!workspaceIdOrName) {
          // Try to get current workspace
          const registry = getWorkspaceRegistry();
          const workspace = await registry.getCurrentWorkspace();
          if (!workspace) {
            throw new Error("No workspace specified and not in a workspace directory");
          }
          await streamLogs(workspace.id);
        } else {
          // Find workspace by ID or name
          const registry = getWorkspaceRegistry();
          const workspace = await registry.findById(workspaceIdOrName) ||
            await registry.findByName(workspaceIdOrName);
          if (!workspace) {
            throw new Error(`Workspace '${workspaceIdOrName}' not found`);
          }
          await streamLogs(workspace.id);
        }
      } catch (err) {
        setError(err.message);
      }
    })();
  }, []);

  async function streamLogs(workspaceId: string) {
    const logger = AtlasLogger.getInstance();
    const reader = new WorkspaceLogReader(logger, workspaceId);

    // Apply filters
    const filters: LogFilters = {
      level: flags.level,
      since: flags.since ? parseDuration(flags.since) : undefined,
      context: parseContextFilters(flags.context),
    };

    if (flags.follow) {
      setStreaming(true);
      // Stream logs with tail
      await reader.follow({
        tail: flags.tail || 100,
        filters,
        onLog: (log) => {
          setLogs((prev) => [...prev, formatLog(log, flags)]);
        },
      });
    } else {
      // Read logs once
      const entries = await reader.read({
        tail: flags.tail || 100,
        filters,
      });
      setLogs(entries.map((log) => formatLog(log, flags)));
    }
  }

  if (error) {
    return <Text color="red">Error: {error}</Text>;
  }

  return (
    <Box flexDirection="column">
      {logs.map((log, i) => <Text key={i}>{log}</Text>)}
      {streaming && logs.length === 0 && <Text color="gray">Waiting for logs...</Text>}
    </Box>
  );
}
```

#### 3.4.2 Implement Log Reading and Streaming

Create `src/cli/commands/workspace/log-reader.ts`:

```typescript
import { join } from "@std/path";
import { LogEntry } from "../../../utils/logger.ts";

export interface LogFilters {
  level?: string;
  since?: Date;
  context?: Record<string, string>;
}

export interface ReadOptions {
  tail?: number;
  filters?: LogFilters;
}

export interface FollowOptions extends ReadOptions {
  onLog: (entry: LogEntry) => void;
  pollInterval?: number;
}

export class WorkspaceLogReader {
  private logPath: string;
  private fileHandle?: Deno.FsFile;
  private followAbort?: AbortController;

  constructor(
    private logger: AtlasLogger,
    private workspaceId: string,
  ) {
    const homeDir = Deno.env.get("HOME") || Deno.env.get("USERPROFILE") || Deno.cwd();
    this.logPath = join(homeDir, ".atlas", "logs", "workspaces", `${workspaceId}.log`);
  }

  async read(options: ReadOptions = {}): Promise<LogEntry[]> {
    const { tail = 100, filters } = options;

    try {
      const content = await Deno.readTextFile(this.logPath);
      const lines = content.trim().split("\n").filter(Boolean);

      // Parse log entries
      let entries: LogEntry[] = [];
      for (const line of lines) {
        try {
          const entry = JSON.parse(line) as LogEntry;
          if (this.matchesFilters(entry, filters)) {
            entries.push(entry);
          }
        } catch {
          // Skip malformed lines
        }
      }

      // Return last N entries
      return entries.slice(-tail);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return [];
      }
      throw error;
    }
  }

  async follow(options: FollowOptions): Promise<void> {
    const { tail = 100, filters, onLog, pollInterval = 1000 } = options;

    // First, read existing logs
    const initial = await this.read({ tail, filters });
    for (const entry of initial) {
      onLog(entry);
    }

    // Open file for watching
    this.fileHandle = await Deno.open(this.logPath, { read: true });
    const decoder = new TextDecoder();
    let buffer = "";
    let position = (await this.fileHandle.stat()).size;

    this.followAbort = new AbortController();

    // Poll for new content
    const pollLoop = async () => {
      while (!this.followAbort.signal.aborted) {
        try {
          const stat = await this.fileHandle!.stat();
          if (stat.size > position) {
            // Read new content
            const newContent = new Uint8Array(stat.size - position);
            await this.fileHandle!.seek(position, Deno.SeekMode.Start);
            const bytesRead = await this.fileHandle!.read(newContent);

            if (bytesRead) {
              position += bytesRead;
              buffer += decoder.decode(newContent.subarray(0, bytesRead));

              // Process complete lines
              const lines = buffer.split("\n");
              buffer = lines.pop() || ""; // Keep incomplete line in buffer

              for (const line of lines) {
                if (line.trim()) {
                  try {
                    const entry = JSON.parse(line) as LogEntry;
                    if (this.matchesFilters(entry, filters)) {
                      onLog(entry);
                    }
                  } catch {
                    // Skip malformed lines
                  }
                }
              }
            }
          }
        } catch (error) {
          if (!this.followAbort.signal.aborted) {
            console.error("Error reading log file:", error);
          }
          break;
        }

        // Wait before next poll
        await new Promise((resolve) => setTimeout(resolve, pollInterval));
      }
    };

    await pollLoop();
  }

  stop(): void {
    if (this.followAbort) {
      this.followAbort.abort();
    }
    if (this.fileHandle) {
      this.fileHandle.close();
    }
  }

  private matchesFilters(entry: LogEntry, filters?: LogFilters): boolean {
    if (!filters) return true;

    // Level filter
    if (filters.level) {
      const levels = ["error", "warn", "info", "debug", "trace"];
      const entryLevel = levels.indexOf(entry.level);
      const filterLevel = levels.indexOf(filters.level);
      if (entryLevel < filterLevel) return false;
    }

    // Time filter
    if (filters.since && new Date(entry.timestamp) < filters.since) {
      return false;
    }

    // Context filters
    if (filters.context && entry.context) {
      for (const [key, value] of Object.entries(filters.context)) {
        if (entry.context[key] !== value) return false;
      }
    }

    return true;
  }
}

// Helper functions
export function parseDuration(duration: string): Date {
  const match = duration.match(/^(\d+)([smhd])$/);
  if (!match) {
    throw new Error(`Invalid duration format: ${duration}`);
  }

  const [, amount, unit] = match;
  const value = parseInt(amount, 10);
  const now = new Date();

  switch (unit) {
    case "s":
      now.setSeconds(now.getSeconds() - value);
      break;
    case "m":
      now.setMinutes(now.getMinutes() - value);
      break;
    case "h":
      now.setHours(now.getHours() - value);
      break;
    case "d":
      now.setDate(now.getDate() - value);
      break;
  }

  return now;
}

export function parseContextFilters(filters?: string[]): Record<string, string> | undefined {
  if (!filters || filters.length === 0) return undefined;

  const result: Record<string, string> = {};
  for (const filter of filters) {
    const [key, value] = filter.split("=");
    if (key && value) {
      result[key] = value;
    }
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

export function formatLog(
  entry: LogEntry,
  flags: { timestamps?: boolean; json?: boolean },
): string {
  if (flags.json) {
    return JSON.stringify(entry);
  }

  const parts: string[] = [];

  if (flags.timestamps !== false) {
    parts.push(entry.timestamp);
  }

  parts.push(entry.level.toUpperCase());

  if (entry.context) {
    const contextStr = Object.entries(entry.context)
      .map(([k, v]) => `${k}=${v}`)
      .join(" ");
    parts.push(`[${contextStr}]`);
  }

  parts.push(entry.message);

  return parts.join(" ");
}
```

#### 3.4.3 Update Workspace Command Router

Update `src/cli/commands/workspace.tsx`:

```typescript
import { WorkspaceLogsCommand } from "./workspace/logs.tsx";

// In the switch statement, add:
case "logs":
  return <WorkspaceLogsCommand args={args} flags={flags} />;
```

#### 3.4.4 Update CLI Meow Configuration

Update `src/cli.tsx` to add the workspace logs flags:

```typescript
flags: {
  // ... existing flags ...
  follow: {
    type: "boolean",
    shortFlag: "f",
    default: false,
  },
  tail: {
    type: "number",
    default: 100,
  },
  since: {
    type: "string",
  },
  timestamps: {
    type: "boolean",
    default: true,
  },
  "no-timestamps": {
    type: "boolean",
    default: false,
  },
  json: {
    type: "boolean",
    default: false,
  },
  level: {
    type: "string",
  },
  context: {
    type: "string",
    isMultiple: true,
  },
}
```

### Implementation Notes

1. **File Watching**: Use polling instead of Deno's file watcher API for better cross-platform
   compatibility
2. **Performance**: For large log files, consider implementing a more efficient tail algorithm using
   file seeking
3. **Memory Management**: When following logs, implement a circular buffer to prevent unlimited
   memory growth
4. **Error Handling**: Gracefully handle missing log files, permission errors, and file rotation
5. **Signal Handling**: Properly clean up file handles and abort controllers on process termination

### Testing Strategy

1. **Unit Tests**: Test log parsing, filtering, and formatting functions
2. **Integration Tests**: Test reading from actual log files
3. **Performance Tests**: Ensure efficient handling of large log files
4. **Stress Tests**: Test following logs with high write rates

### Future Enhancements

1. **Log Rotation Support**: Handle log rotation gracefully when following
2. **Multi-Workspace Logs**: Support tailing logs from multiple workspaces simultaneously
3. **Advanced Filtering**: Support regex patterns and complex queries
4. **Export Functionality**: Export filtered logs to files
5. **Log Analysis**: Basic log analysis features (error rates, patterns, etc.)

## Future Extensions

Once the registry is in place, we can add:

1. **Detached Process Support**: Track background workspaces
2. **Workspace Templates**: Create new workspaces from templates
3. **Workspace Groups**: Organize workspaces with tags/groups
4. **Remote Workspaces**: Register remote Atlas instances
5. **Workspace Metrics**: Track usage, uptime, etc.

This foundation will make Atlas more powerful and user-friendly while maintaining simplicity.

## Implementation Summary (December 2024)

### What We Achieved

1. **Full Registry Core**: All planned registry functionality is working
2. **Enhanced Features**: Added dynamic port assignment and better status tracking
3. **Simplified Design**: Removed lockfile mechanism for better reliability
4. **Auto-Discovery**: Workspaces are automatically imported on registry init
5. **Better UX**: Can run `atlas workspace serve <name>` from anywhere

### What Changed from Plan

1. **No Lockfile**: Removed file-based locking in favor of atomic operations
2. **Singleton Pattern**: Using `getWorkspaceRegistry()` instead of global export
3. **Dynamic Ports**: Added port finder utility for conflict-free operation
4. **Status Fixes**: Enhanced lazy health checks to handle all process states

### Current Capabilities

- Run multiple workspaces simultaneously without port conflicts
- Track workspace status accurately even when processes are killed
- Navigate workspaces by memorable Docker-style names
- Auto-discover and import existing workspaces
- Clean table view of all registered workspaces
