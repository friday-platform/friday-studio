# Config Loader Refactor & Storage Package Migration Plan (Revised)

## 1. Objective

This plan outlines two interconnected goals:

1. **Start the Monorepo Migration**: Begin the transition to a Deno workspace by creating the first
   shared package, `@atlas/storage`, as outlined in the monorepo migration plan.
2. **Refactor the `ConfigLoader`**: Decouple the configuration loading logic from the filesystem by
   creating a `ConfigurationAdapter` that will reside in the new `@atlas/storage` package.

This effort will improve modularity, establish clearer ownership, and make the configuration system
more extensible and testable.

## 2. Monorepo Foundation: Creating the Storage Package

As per the `MONOREPO_MIGRATION_PLAN.md`, we will start by creating the `packages` directory and
adding our first package.

1. **Create `packages` Directory**: This directory will house all shared, reusable modules.
2. **Create `@atlas/storage` Package**:
   - Create the directory `packages/storage/src/config`.
   - Create a `deno.json` file inside `packages/storage` to define it as a package.
3. **Update Root `deno.json`**: The root `deno.json` will be updated to recognize the new `packages`
   directory as a workspace.

## 3. Configuration Adapter Architecture

The new configuration adapter will be the first component inside the `@atlas/storage` package.

### 3.1. `IConfigurationAdapter` Interface

This interface defines the contract for loading configuration data.

**File:** `packages/storage/src/config/config-adapter.ts`

```typescript
import type {
  AtlasConfig,
  JobSpecification,
  WorkspaceConfig,
} from "../../../../src/core/config-loader.ts";

export interface IConfigurationAdapter {
  loadAtlasConfig(): Promise<AtlasConfig>;
  loadWorkspaceConfig(): Promise<WorkspaceConfig>;
  loadJobSpecs(): Promise<Record<string, JobSpecification>>;
  loadSupervisorDefaults(): Promise<any>;
}
```

### 3.2. `FileSystemConfigurationAdapter`

This will be the first implementation of the `IConfigurationAdapter`, encapsulating filesystem
logic.

**File:** `packages/storage/src/config/filesystem-config-adapter.ts`

```typescript
import { join } from "@std/path";
import { parse as parseYaml } from "@std/yaml";
import { z } from "zod/v4";
import { IConfigurationAdapter } from "./config-adapter.ts";
import type {
  AtlasConfig,
  AtlasConfigSchema,
  ConfigValidationError,
  JobSpecification,
  WorkspaceConfig,
  WorkspaceConfigSchema,
} from "../../../../src/core/config-loader.ts";
import xdg from "npm:xdg-portable";

export class FileSystemConfigurationAdapter implements IConfigurationAdapter {
  private workspaceDir: string;
  private atlasConfigPath: string | null = null;
  private workspaceConfigPath: string;

  constructor(workspaceDir: string = ".") {
    this.workspaceDir = workspaceDir;
    this.workspaceConfigPath = join(this.workspaceDir, "workspace.yml");
    // The constructor will resolve the atlas.yml path when loadAtlasConfig is called.
  }

  private async findAtlasConfig(): Promise<string> {
    // 1. Check current workspace directory.
    const localPath = join(this.workspaceDir, "atlas.yml");
    try {
      await Deno.stat(localPath);
      return localPath;
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) throw e;
    }

    // 2. If not found, check XDG config directory.
    const xdgConfigPath = join(xdg.config(), "atlas", "atlas.yml");
    try {
      await Deno.stat(xdgConfigPath);
      return xdgConfigPath;
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) throw e;
    }

    // Return local path as default for creation if not found anywhere.
    return localPath;
  }

  async loadAtlasConfig(): Promise<AtlasConfig> {
    if (!this.atlasConfigPath) {
      this.atlasConfigPath = await this.findAtlasConfig();
    }
    // ... logic to read and parse atlas.yml from the resolved path
  }

  // ... other load methods
}
```

### 3.3. Refactored `ConfigLoader`

The `ConfigLoader` will be simplified to orchestrate the loading process using the adapter, which it
will import from the new `@atlas/storage` package.

**File:** `src/core/config-loader.ts` (Refactored)

```typescript
import { IConfigurationAdapter } from "@atlas/storage/config-adapter.ts";
import type {
  AtlasConfig,
  JobSpecification,
  MergedConfig,
  WorkspaceConfig,
} from "./config-loader.ts";

export class ConfigLoader {
  constructor(private adapter: IConfigurationAdapter) {}

  async load(): Promise<MergedConfig> {
    const supervisorDefaults = await this.adapter.loadSupervisorDefaults();
    const atlasConfig = await this.adapter.loadAtlasConfig();
    const workspaceConfig = await this.adapter.loadWorkspaceConfig();
    const jobsFromAdapter = await this.adapter.loadJobSpecs();

    // The logic for merging, combining, and validating remains in the ConfigLoader.
    const mergedAtlasConfig = this.mergeSupervisorDefaults(
      atlasConfig,
      supervisorDefaults,
    );
    const allJobs = this.combineJobs(workspaceConfig, jobsFromAdapter);
    this.validateConfig(mergedAtlasConfig, workspaceConfig, allJobs);

    return {
      atlas: mergedAtlasConfig,
      workspace: workspaceConfig,
      jobs: allJobs,
      supervisorDefaults,
    };
  }

  // ... private methods for merging and validation
}
```

## 4. Combined Implementation Steps

1. **Install Dependency**: Add the `xdg-portable` package by running `deno add npm:xdg-portable`.
2. **Create `packages` Directory**: Run `mkdir -p packages/storage/src/config`.
3. **Create Package `deno.json`**: Create a `packages/storage/deno.json` file with the following
   content:
   ```json
   {
     "name": "@atlas/storage",
     "version": "0.1.0",
     "exports": "./src/config/config-adapter.ts"
   }
   ```
4. **Update Root `deno.json`**: Add the `workspaces` property to the root `deno.json` file:
   ```json
   {
     // ... existing config
     "workspaces": ["packages/*"]
   }
   ```
5. **Define Interface**: Create `packages/storage/src/config/config-adapter.ts` and define the
   `IConfigurationAdapter` interface.
6. **Create Filesystem Adapter**: Create `packages/storage/src/config/filesystem-config-adapter.ts`.
7. **Migrate Logic**: Move filesystem-related logic from `src/core/config-loader.ts` to
   `FileSystemConfigurationAdapter`, implementing the new `atlas.yml` search strategy (CWD -> XDG).
8. **Refactor `ConfigLoader`**:
   - Change its constructor to accept an `IConfigurationAdapter`.
   - Update its `load()` method to call the adapter's methods.
   - Change the import to use the new package:
     `import { IConfigurationAdapter } from "@atlas/storage/config-adapter.ts";`.
9. **Update Instantiation Points**: Find all places where `new ConfigLoader()` is called and update
   them to pass the new `FileSystemConfigurationAdapter`.
10. **Run All Tests**: Execute the full test suite (`deno task test`) to ensure the refactoring has
    not introduced any regressions.

## 5. Benefits of This Approach

- **Decoupling**: `ConfigLoader` is no longer responsible for _how_ config is fetched.
- **Testability**: `ConfigLoader` can be unit-tested with a mock adapter.
- **Extensibility**: New configuration sources can be added by creating new adapters.
- **Improved Modularity**: Begins the formal separation of concerns into distinct packages within a
  monorepo.
- **Clearer Ownership**: Establishes `@atlas/storage` as the owner of data access patterns.
