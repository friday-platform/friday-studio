# Config Loader Refactor & Monorepo Migration Plan

## Overview

This plan outlines the migration of the configuration loading system from `src/core/config-loader.ts` into the monorepo structure, introducing an adapter pattern to decouple configuration loading logic from filesystem operations.

## Goals

1. **Move configuration schemas and inferred types** to `@atlas/config` package
2. **Introduce adapter pattern** for configuration sources in `@atlas/storage` package
3. **Refactor ConfigLoader** to use dependency injection with adapters
4. **Update all call sites** to use the new package structure
5. **Enable extensibility** for future configuration sources (e.g., remote config, databases)
6. **Add comprehensive test coverage** for both packages

## Current State Analysis

### ConfigLoader Responsibilities
- Loading `atlas.yml` and `workspace.yml` files
- Parsing YAML configuration
- Validating configurations with Zod schemas
- Merging supervisor defaults
- Loading job specifications from files
- Managing configuration paths (workspace-local vs git root)

### Usage Locations
- `src/core/atlas-daemon.ts` - Line 732: `new ConfigLoader(workspace.path)`
- `src/core/workspace-manager.ts` - Configuration caching and validation
- `src/core/workspace-runtime.ts` - Runtime configuration

## Migration Architecture

### Phase 1: Extract Schemas and Types to `@atlas/config`

#### 1.1 Move Zod Schemas and Infer Types
Create `packages/config/src/schemas.ts`:
```typescript
import { z } from "zod/v4";

// All Zod schemas
export const AtlasConfigSchema = z.object({ ... });
export const WorkspaceConfigSchema = z.object({ ... });
export const JobSpecificationSchema = z.object({ ... });
// ... all other schemas

// Infer types from schemas (colocated)
export type AtlasConfig = z.infer<typeof AtlasConfigSchema>;
export type WorkspaceConfig = z.infer<typeof WorkspaceConfigSchema>;
export type JobSpecification = z.infer<typeof JobSpecificationSchema>;
// ... all other types

// Additional types not derived from schemas
export interface MergedConfig {
  atlas: AtlasConfig;
  workspace: WorkspaceConfig;
  jobs: Record<string, JobSpecification>;
  supervisorDefaults: any;
}
```

#### 1.2 Move Validation Logic
Create `packages/config/src/validation.ts`:
```typescript
import { z } from "zod/v4";

export class ConfigValidationError extends Error {
  constructor(
    message: string,
    public file: string,
    public field?: string,
    public value?: unknown,
  ) {
    super(message);
    this.name = "ConfigValidationError";
  }
}

export function formatZodError(error: z.ZodError, filename: string): string {
  const issues = error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "root";
    let message = `  • ${path}: ${issue.message}`;
    if ("received" in issue && issue.received !== undefined) {
      message += ` (received: ${issue.received})`;
    }
    return message;
  });

  return `Configuration validation failed in ${filename}:\n${issues.join("\n")}`;
}
```

### Phase 2: Create Configuration Adapter in `@atlas/storage`

#### 2.1 Define Adapter Interface
Create `packages/storage/src/adapters/config-adapter.ts`:
```typescript
export interface ConfigurationAdapter {
  // Core loading methods
  loadYamlFile(path: string): Promise<unknown>;
  fileExists(path: string): Promise<boolean>;
  
  // Path resolution
  resolveAtlasConfigPath(workspaceDir: string): Promise<string>;
  resolveWorkspaceConfigPath(workspaceDir: string): Promise<string>;
  
  // Job loading
  loadJobFiles(jobsDir: string): Promise<Map<string, unknown>>;
  
  // Supervisor defaults
  loadSupervisorDefaults(): Promise<unknown>;
}
```

#### 2.2 Implement Filesystem Adapter
Create `packages/storage/src/adapters/filesystem-config-adapter.ts`:
```typescript
import { join } from "@std/path";
import { parse as parseYaml } from "@std/yaml";
import xdg from "npm:xdg-portable";

export class FilesystemConfigAdapter implements ConfigurationAdapter {
  async loadYamlFile(path: string): Promise<unknown> {
    const content = await Deno.readTextFile(path);
    return parseYaml(content);
  }

  async fileExists(path: string): Promise<boolean> {
    try {
      await Deno.stat(path);
      return true;
    } catch {
      return false;
    }
  }

  async resolveAtlasConfigPath(workspaceDir: string): Promise<string> {
    // 1. Check current working directory (CWD)
    const cwdAtlasPath = join(workspaceDir, "atlas.yml");
    if (await this.fileExists(cwdAtlasPath)) {
      return cwdAtlasPath;
    }

    // 2. Check git root
    try {
      const gitRoot = await this.getGitRoot();
      const gitAtlasPath = join(gitRoot, "atlas.yml");
      if (await this.fileExists(gitAtlasPath)) {
        return gitAtlasPath;
      }
    } catch {
      // Git not available, continue to XDG
    }

    // 3. Check XDG config directory
    const xdgConfigPath = join(xdg.config(), "atlas", "atlas.yml");
    if (await this.fileExists(xdgConfigPath)) {
      return xdgConfigPath;
    }

    // Return CWD path as default for creation
    return cwdAtlasPath;
  }

  async resolveWorkspaceConfigPath(workspaceDir: string): Promise<string> {
    return join(workspaceDir, "workspace.yml");
  }

  async loadJobFiles(jobsDir: string): Promise<Map<string, unknown>> {
    const jobs = new Map<string, unknown>();
    
    try {
      for await (const entry of Deno.readDir(jobsDir)) {
        if (entry.isFile && (entry.name.endsWith(".yml") || entry.name.endsWith(".yaml"))) {
          const content = await this.loadYamlFile(join(jobsDir, entry.name));
          const jobName = entry.name.replace(/\.(yml|yaml)$/, "");
          jobs.set(jobName, content);
        }
      }
    } catch {
      // Jobs directory doesn't exist
    }
    
    return jobs;
  }

  async loadSupervisorDefaults(): Promise<unknown> {
    // This will need to be configurable - for now, use compiled defaults
    const { supervisorDefaults } = await import("../../../config/supervisor-defaults.ts");
    return supervisorDefaults;
  }

  private async getGitRoot(): Promise<string> {
    const gitRoot = new Deno.Command("git", {
      args: ["rev-parse", "--show-toplevel"],
      stdout: "piped",
    }).outputSync();
    
    if (!gitRoot.success) {
      throw new Error("Not in a git repository");
    }
    
    return new TextDecoder().decode(gitRoot.stdout).trim();
  }
}
```

### Phase 3: Refactor ConfigLoader in `@atlas/config`

#### 3.1 Move and Refactor ConfigLoader
Create `packages/config/src/config-loader.ts`:
```typescript
import type { ConfigurationAdapter } from "@atlas/storage";
import { 
  AtlasConfig, 
  WorkspaceConfig, 
  MergedConfig,
  JobSpecification 
} from "./types.ts";
import { 
  AtlasConfigSchema, 
  WorkspaceConfigSchema,
  JobSpecificationSchema 
} from "./schemas.ts";
import { ConfigValidationError, formatZodError } from "./validation.ts";

export class ConfigLoader {
  constructor(
    private adapter: ConfigurationAdapter,
    private workspaceDir: string = "."
  ) {}

  async load(): Promise<MergedConfig> {
    // Load supervisor defaults
    const supervisorDefaults = await this.adapter.loadSupervisorDefaults();
    
    // Load atlas.yml
    const atlasConfig = await this.loadAtlasConfig();
    
    // Merge supervisor defaults
    const mergedAtlasConfig = this.mergeSupervisorDefaults(
      atlasConfig, 
      supervisorDefaults
    );
    
    // Load workspace.yml
    const workspaceConfig = await this.loadWorkspaceConfig();
    
    // Load job specifications
    const jobs = await this.loadJobSpecs(workspaceConfig);
    
    // Validate configuration
    this.validateConfig(mergedAtlasConfig, workspaceConfig, jobs);
    
    return {
      atlas: mergedAtlasConfig,
      workspace: workspaceConfig,
      jobs,
      supervisorDefaults,
    };
  }

  private async loadAtlasConfig(): Promise<AtlasConfig> {
    const atlasPath = await this.adapter.resolveAtlasConfigPath(this.workspaceDir);
    
    try {
      const rawConfig = await this.adapter.loadYamlFile(atlasPath);
      return AtlasConfigSchema.parse(rawConfig);
    } catch (error) {
      if (error instanceof Error && error.message.includes("NotFound")) {
        return this.createDefaultAtlasConfig();
      }
      throw this.handleConfigError(error, "atlas.yml");
    }
  }

  private async loadWorkspaceConfig(): Promise<WorkspaceConfig> {
    const workspacePath = await this.adapter.resolveWorkspaceConfigPath(this.workspaceDir);
    
    try {
      const rawConfig = await this.adapter.loadYamlFile(workspacePath);
      return WorkspaceConfigSchema.parse(rawConfig);
    } catch (error) {
      throw this.handleConfigError(error, "workspace.yml");
    }
  }

  private async loadJobSpecs(
    workspaceConfig: WorkspaceConfig
  ): Promise<Record<string, JobSpecification>> {
    const jobs: Record<string, JobSpecification> = {};
    
    // Load inline jobs from workspace config
    if (workspaceConfig.jobs) {
      Object.entries(workspaceConfig.jobs).forEach(([name, spec]) => {
        jobs[name] = this.normalizeJobSpec(name, spec);
      });
    }
    
    // Load jobs from files
    const jobsDir = join(this.workspaceDir, "jobs");
    const jobFiles = await this.adapter.loadJobFiles(jobsDir);
    
    for (const [name, rawSpec] of jobFiles) {
      const spec = JobSpecificationSchema.parse(rawSpec);
      jobs[name] = this.normalizeJobSpec(name, spec);
    }
    
    return jobs;
  }

  // ... other private methods remain largely the same
}
```

### Phase 4: Update All Usage Sites

#### 4.1 Export from Package
Create `packages/config/src/index.ts`:
```typescript
export * from "./schemas.ts";
export * from "./validation.ts";
export { ConfigLoader } from "./config-loader.ts";
```

#### 4.2 Update atlas-daemon.ts
```typescript
import { ConfigLoader } from "@atlas/config";
import { FilesystemConfigAdapter } from "@atlas/storage";

// Line 732 becomes:
const adapter = new FilesystemConfigAdapter();
const configLoader = new ConfigLoader(adapter, workspace.path);
```

#### 4.3 Update workspace-manager.ts
```typescript
import { ConfigLoader } from "@atlas/config";
import { FilesystemConfigAdapter } from "@atlas/storage";

// Update all ConfigLoader instantiations to use adapter
```

#### 4.4 Update workspace-runtime.ts
```typescript
import type { MergedConfig } from "@atlas/config";
// Update imports as needed
```

## Implementation Steps

### Step 1: Package Setup
1. Ensure `packages/config` and `packages/storage` directories exist
2. Update their `mod.ts` files with proper exports

### Step 2: Type Migration
1. Copy all type definitions from `config-loader.ts` to `packages/config/src/types.ts`
2. Copy all Zod schemas to `packages/config/src/schemas.ts`
3. Extract validation utilities to `packages/config/src/validation.ts`

### Step 3: Adapter Implementation
1. Create the `ConfigurationAdapter` interface in `packages/storage`
2. Implement `FilesystemConfigAdapter` with all filesystem operations
3. Add tests for the adapter

### Step 4: ConfigLoader Refactoring
1. Copy `ConfigLoader` class to `packages/config/src/config-loader.ts`
2. Refactor to use the adapter pattern
3. Remove all direct filesystem operations
4. Update imports to use package references

### Step 5: Integration
1. Update `src/core/config-loader.ts` to re-export from `@atlas/config`
2. Test that existing code continues to work
3. Gradually update import statements across the codebase

### Step 6: Cleanup
1. Remove `src/core/config-loader.ts`
2. Update documentation
3. Add migration notes to CLAUDE.md
4. Update existing tests to use new package imports

## Benefits

1. **Separation of Concerns**: Configuration logic separated from I/O operations
2. **Testability**: Easy to mock adapters for unit testing
3. **Extensibility**: New configuration sources can be added via new adapters
4. **Incremental Migration**: Can be done step-by-step without breaking existing code
5. **Type Safety**: All types and schemas in one place
6. **Reusability**: Config package can be used independently

## Testing Strategy

### `packages/config/tests/` - Unit Tests

#### `config-loader.test.ts`
```typescript
import { expect } from "@std/expect";
import { ConfigLoader } from "../src/config-loader.ts";
import type { ConfigurationAdapter } from "@atlas/storage";

// Mock adapter for testing
class MockConfigAdapter implements ConfigurationAdapter {
  private files = new Map<string, unknown>();
  
  constructor(files: Record<string, unknown>) {
    Object.entries(files).forEach(([path, content]) => {
      this.files.set(path, content);
    });
  }
  
  async loadYamlFile(path: string): Promise<unknown> {
    if (!this.files.has(path)) {
      throw new Error(`NotFound: ${path}`);
    }
    return this.files.get(path);
  }
  
  async fileExists(path: string): Promise<boolean> {
    return this.files.has(path);
  }
  
  async resolveAtlasConfigPath(workspaceDir: string): Promise<string> {
    return `${workspaceDir}/atlas.yml`;
  }
  
  async resolveWorkspaceConfigPath(workspaceDir: string): Promise<string> {
    return `${workspaceDir}/workspace.yml`;
  }
  
  async loadJobFiles(jobsDir: string): Promise<Map<string, unknown>> {
    return new Map();
  }
  
  async loadSupervisorDefaults(): Promise<unknown> {
    return {
      supervisors: {
        workspace: { model: "test", prompts: { system: "test" } },
        session: { model: "test", prompts: { system: "test" } },
        agent: { model: "test", prompts: { system: "test" } }
      }
    };
  }
}

Deno.test("ConfigLoader - loads valid configuration", async () => {
  const mockAdapter = new MockConfigAdapter({
    "/test/atlas.yml": {
      version: "1.0",
      workspace: { id: "atlas-platform", name: "Atlas Platform" },
      supervisors: {
        workspace: { model: "claude-3-5-sonnet", prompts: { system: "workspace" } },
        session: { model: "claude-3-5-sonnet", prompts: { system: "session" } },
        agent: { model: "claude-3-5-sonnet", prompts: { system: "agent" } }
      }
    },
    "/test/workspace.yml": {
      version: "1.0",
      workspace: { name: "test-workspace" },
      agents: {},
      signals: {}
    }
  });
  
  const loader = new ConfigLoader(mockAdapter, "/test");
  const config = await loader.load();
  
  expect(config.atlas).toBeDefined();
  expect(config.workspace).toBeDefined();
  expect(config.workspace.workspace.name).toBe("test-workspace");
});

Deno.test("ConfigLoader - handles missing atlas.yml gracefully", async () => {
  const mockAdapter = new MockConfigAdapter({
    "/test/workspace.yml": {
      version: "1.0",
      workspace: { name: "test-workspace" },
      agents: {},
      signals: {}
    }
  });
  
  const loader = new ConfigLoader(mockAdapter, "/test");
  const config = await loader.load();
  
  // Should create default atlas config
  expect(config.atlas.workspace.id).toBe("atlas-platform");
  expect(config.atlas.workspace.name).toBe("Atlas Platform");
});

Deno.test("ConfigLoader - validates workspace configuration", async () => {
  const mockAdapter = new MockConfigAdapter({
    "/test/atlas.yml": { /* valid atlas config */ },
    "/test/workspace.yml": {
      version: "1.0",
      // Missing required 'workspace' field
      agents: {}
    }
  });
  
  const loader = new ConfigLoader(mockAdapter, "/test");
  
  await expect(loader.load()).rejects.toThrow("Configuration validation failed");
});
```

#### `validation.test.ts`
```typescript
import { expect } from "@std/expect";
import { z } from "zod/v4";
import { formatZodError, ConfigValidationError } from "../src/validation.ts";

Deno.test("formatZodError - formats validation errors correctly", () => {
  const schema = z.object({
    name: z.string(),
    age: z.number()
  });
  
  try {
    schema.parse({ name: 123, age: "invalid" });
  } catch (error) {
    if (error instanceof z.ZodError) {
      const formatted = formatZodError(error, "test.yml");
      expect(formatted).toContain("Configuration validation failed in test.yml");
      expect(formatted).toContain("name:");
      expect(formatted).toContain("age:");
    }
  }
});

Deno.test("ConfigValidationError - includes all error details", () => {
  const error = new ConfigValidationError(
    "Invalid configuration",
    "test.yml",
    "agents.test-agent",
    { type: "invalid" }
  );
  
  expect(error.name).toBe("ConfigValidationError");
  expect(error.file).toBe("test.yml");
  expect(error.field).toBe("agents.test-agent");
  expect(error.value).toEqual({ type: "invalid" });
});
```

### `packages/storage/tests/` - Unit Tests

#### `filesystem-config-adapter.test.ts`
```typescript
import { expect } from "@std/expect";
import { FilesystemConfigAdapter } from "../src/adapters/filesystem-config-adapter.ts";
import { join } from "@std/path";

// Create temp directory for tests
const tempDir = await Deno.makeTempDir();

Deno.test("FilesystemConfigAdapter - loads YAML files", async () => {
  const adapter = new FilesystemConfigAdapter();
  const testFile = join(tempDir, "test.yml");
  
  await Deno.writeTextFile(testFile, "name: test\nvalue: 123");
  
  const content = await adapter.loadYamlFile(testFile);
  expect(content).toEqual({ name: "test", value: 123 });
});

Deno.test("FilesystemConfigAdapter - checks file existence", async () => {
  const adapter = new FilesystemConfigAdapter();
  const existingFile = join(tempDir, "exists.yml");
  const missingFile = join(tempDir, "missing.yml");
  
  await Deno.writeTextFile(existingFile, "test");
  
  expect(await adapter.fileExists(existingFile)).toBe(true);
  expect(await adapter.fileExists(missingFile)).toBe(false);
});

Deno.test("FilesystemConfigAdapter - resolves atlas.yml path correctly", async () => {
  const adapter = new FilesystemConfigAdapter();
  
  // Test CWD resolution
  const cwdAtlas = join(tempDir, "atlas.yml");
  await Deno.writeTextFile(cwdAtlas, "version: 1.0");
  
  const resolvedPath = await adapter.resolveAtlasConfigPath(tempDir);
  expect(resolvedPath).toBe(cwdAtlas);
  
  // Clean up for next test
  await Deno.remove(cwdAtlas);
});

Deno.test("FilesystemConfigAdapter - loads job files from directory", async () => {
  const adapter = new FilesystemConfigAdapter();
  const jobsDir = join(tempDir, "jobs");
  
  await Deno.mkdir(jobsDir);
  await Deno.writeTextFile(join(jobsDir, "job1.yml"), "name: job1\ntask: test");
  await Deno.writeTextFile(join(jobsDir, "job2.yaml"), "name: job2\ntask: test");
  await Deno.writeTextFile(join(jobsDir, "not-yaml.txt"), "ignored");
  
  const jobs = await adapter.loadJobFiles(jobsDir);
  
  expect(jobs.size).toBe(2);
  expect(jobs.has("job1")).toBe(true);
  expect(jobs.has("job2")).toBe(true);
  expect(jobs.has("not-yaml")).toBe(false);
});

// Cleanup after all tests
globalThis.addEventListener("unload", () => {
  Deno.removeSync(tempDir, { recursive: true });
});
```

### Integration Test Updates
Update `tests/integration/configuration-architecture.test.ts`:
```typescript
import { expect } from "@std/expect";
import { ConfigLoader } from "@atlas/config";
import { FilesystemConfigAdapter } from "@atlas/storage";

Deno.test("Configuration architecture - platform vs workspace separation", async () => {
  const tempDir = await Deno.makeTempDir();
  
  // Write test configurations
  await Deno.writeTextFile(join(tempDir, "atlas.yml"), validAtlasConfig);
  await Deno.writeTextFile(join(tempDir, "workspace.yml"), validWorkspaceConfig);
  
  const adapter = new FilesystemConfigAdapter();
  const loader = new ConfigLoader(adapter, tempDir);
  const config = await loader.load();
  
  // Test platform configuration
  expect(config.atlas.agents).toBeDefined();
  expect(config.atlas.agents["memory-agent"]).toBeDefined();
  
  // Test workspace configuration
  expect(config.workspace.signals).toBeDefined();
  expect(config.workspace.agents).toBeDefined();
  
  // Cleanup
  await Deno.remove(tempDir, { recursive: true });
});
```

## Success Criteria

1. All existing tests pass
2. Configuration loading works identically to current implementation
3. Clean separation between packages
4. No circular dependencies
5. Improved test coverage for configuration logic