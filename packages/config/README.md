# @atlas/config

Configuration management package for Atlas platform.

## Overview

This package provides:

- Configuration schemas using Zod v4
- Type definitions for all configuration objects
- Validation utilities
- ConfigLoader class with dependency injection
- Default configurations

## Standard Configuration Format

Atlas uses **TypeScript (.ts)** as the standard format for configuration defaults.

### Benefits of TypeScript Defaults

1. **Type Safety**: Automatically validated against Zod schemas at compile time
2. **IDE Support**: Full autocomplete, refactoring, and error detection
3. **No Runtime Parsing**: Defaults are compiled into the application
4. **Richer Data Structures**: Support for template literals and computed values
5. **Single Source of Truth**: Part of the codebase with version control

### Configuration Files

- `src/defaults/supervisor-defaults.ts` - Default supervisor configurations
- `src/defaults/atlas-defaults.ts` - Default Atlas platform settings
- `src/templates/workspace-template.yml` - Template for new workspaces

## Usage

```typescript
import { AtlasConfig, ConfigLoader, supervisorDefaults, WorkspaceConfig } from "@atlas/config";
import { FilesystemConfigAdapter } from "@atlas/storage";

// Load configuration
const adapter = new FilesystemConfigAdapter();
const loader = new ConfigLoader(adapter, workspaceDir);
const config = await loader.load();

// Access typed configuration
const workspace: WorkspaceConfig = config.workspace;
const atlas: AtlasConfig | null = config.atlas;
```

## Schema Types

All configuration types are inferred from Zod schemas:

- `AtlasConfig` - Platform-level configuration
- `WorkspaceConfig` - Workspace-specific configuration
- `SupervisorDefaults` - Default supervisor settings
- `JobSpecification` - Job execution definitions
- `WorkspaceAgentConfig` - Agent configurations
- `MergedConfig` - Combined configuration object

## Validation

The package provides comprehensive validation:

```typescript
import { ConfigValidationError, formatZodError } from "@atlas/config";

try {
  const config = AtlasConfigSchema.parse(rawData);
} catch (error) {
  if (error instanceof z.ZodError) {
    const formatted = formatZodError(error, "config.yml");
    throw new ConfigValidationError(formatted, "config.yml");
  }
}
```

## Testing Utilities

The package exports test fixtures via `@atlas/config/testing` for use in tests
across the codebase.

```typescript
import {
  createTestConfig,
  createMergedConfig,
  httpSignal,
  scheduleSignal,
  llmAgent,
  atlasAgent,
  systemAgent,
  createJob,
  expectError,
} from "@atlas/config/testing";
```

### Factory Functions

| Factory | Creates | Defaults |
|---------|---------|----------|
| `createTestConfig(overrides?)` | `WorkspaceConfig` | Minimal valid workspace |
| `createMergedConfig(workspace)` | `MergedConfig` | Wraps workspace with null atlas |
| `httpSignal(overrides?)` | `HTTPSignalConfig` | Path `/webhook` |
| `scheduleSignal(overrides?)` | `ScheduleSignalConfig` | Cron `0 9 * * *`, UTC |
| `llmAgent(overrides?)` | `LLMAgentConfig` | Anthropic claude-sonnet-4-5 |
| `atlasAgent(overrides?)` | `AtlasAgentConfig` | GitHub agent |
| `systemAgent(overrides?)` | `SystemAgentConfig` | Conversation agent |
| `createJob(overrides?)` | `JobSpecification` | Sequential, one agent |

### Error Assertions

`expectError` eliminates boilerplate when testing mutation errors:

```typescript
// Before: verbose type narrowing
expect(result.ok).toBe(false);
if (!result.ok) {
  expect(result.error.type).toBe("not_found");
  if (result.error.type === "not_found") {
    expect(result.error.entityId).toBe("missing");
  }
}

// After: one line with type-safe callback
expectError(result, "not_found", (e) => expect(e.entityId).toBe("missing"));
```

Error types: `not_found`, `validation`, `conflict`, `invalid_operation`, `write`

## Dependencies

- `@atlas/storage` - For configuration adapters
- `zod` - For schema validation
- `@std/yaml` - For YAML parsing
- `@std/path` - For path operations
