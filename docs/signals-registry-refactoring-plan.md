# Signals Registry Refactoring Plan

## Executive Summary

This document outlines a comprehensive plan to refactor the signals registry system, addressing code
duplication, removing unnecessary dynamic imports, and improving maintainability while minimizing
risk.

## Problem Analysis

### Current Issues

#### 1. Code Duplication

- **Two identical registry classes**: `packages/signals/src/registry.ts` and
  `src/core/providers/registry.ts`
- **Near-identical implementation**: Both classes have ~135 lines of duplicated code
- **Maintenance burden**: Changes must be applied to both files
- **Inconsistent behavior risk**: Classes may diverge over time

#### 2. Unnecessary Dynamic Imports

Current pattern in `src/core/providers/registry.ts`:

```typescript
registry.registerFactory("http", async (config) => {
  const { HTTPSignalProvider } = await import("@atlas/signals");
  return new HTTPSignalProvider(transformConfig(config));
});
```

**Issues**:

- No architectural benefit (all providers are built-in)
- Deferred error handling for import failures
- Performance overhead during initialization
- Reduced static analysis capability
- Violates codebase guidelines preferring static imports

#### 3. Inconsistent Provider Organization

- Most providers: `packages/signals/src/providers/`
- CLI provider: `src/core/providers/builtin/cli-signal.ts`
- Breaks package encapsulation
- Inconsistent import paths

#### 4. Factory Pattern Misuse

The current factory pattern adds complexity without architectural benefit:

```typescript
private factories: Map<string, (config: ProviderConfig) => Promise<IProvider>> = new Map();
```

### Root Cause Analysis

1. **Dynamic imports introduced to avoid circular dependencies** - but this isn't necessary for
   built-in providers
2. **Attempt at plugin architecture** - but no external providers are supported
3. **Premature optimization** - lazy loading provides no benefit when all providers are registered
   at startup

## Implementation Strategy

### Phase 1: Safe Consolidation (Low Risk)

#### 1.1 Remove Duplicate Registry

**Goal**: Eliminate `packages/signals/src/registry.ts`

**Steps**:

1. Update `packages/signals/src/index.ts`:
   ```typescript
   // Remove:
   export { ProviderRegistry } from "./registry.ts";

   // Add:
   export { ProviderRegistry } from "../../../src/core/providers/registry.ts";
   ```

2. Remove the duplicate file:
   ```bash
   rm packages/signals/src/registry.ts
   ```

3. Update all imports from the duplicate registry to use the main registry

**Risk**: Low - only changes import paths

#### 1.2 Create Static Provider Map

**Goal**: Replace dynamic imports with static imports

**Implementation**:

```typescript
// packages/signals/src/providers/provider-map.ts
import { HTTPSignalProvider } from "./http-signal.ts";
import { HttpWebhookProvider } from "./http-webhook.ts";
import { TimerSignalProvider } from "./timer-signal.ts";
import { StreamSignalProvider } from "./stream-signal.ts";
import { K8sEventsSignalProvider } from "./k8s-events.ts";
import { CliSignalProvider } from "../../../src/core/providers/builtin/cli-signal.ts";

export const PROVIDER_CLASSES = {
  "http": HTTPSignalProvider,
  "http-webhook": HttpWebhookProvider,
  "timer": TimerSignalProvider,
  "schedule": TimerSignalProvider,
  "cron": TimerSignalProvider,
  "cron-scheduler": TimerSignalProvider,
  "stream": StreamSignalProvider,
  "k8s-events": K8sEventsSignalProvider,
  "cli": CliSignalProvider,
} as const;

export type ProviderTypeKeys = keyof typeof PROVIDER_CLASSES;
```

**Risk**: Low - creates new file without breaking existing functionality

#### 1.3 Update Main Registry

**Goal**: Replace factory pattern with static provider map

**Implementation**:

```typescript
// src/core/providers/registry.ts
import { PROVIDER_CLASSES } from "@atlas/signals/src/providers/provider-map.ts";

export class ProviderRegistry implements IProviderRegistry {
  // ... existing singleton implementation

  async loadFromConfig(config: ProviderConfig): Promise<IProvider> {
    const existing = this.providers.get(config.id);
    if (existing) {
      return existing;
    }

    const ProviderClass = PROVIDER_CLASSES[config.provider as keyof typeof PROVIDER_CLASSES];
    if (!ProviderClass) {
      throw new Error(`No provider registered for type: ${config.provider}`);
    }

    const provider = this.createProviderInstance(ProviderClass, config);
    this.register(provider);
    return provider;
  }

  private createProviderInstance(ProviderClass: any, config: ProviderConfig): IProvider {
    // Preserve existing configuration transformation logic
    switch (config.provider) {
      case "http":
        return new ProviderClass({
          id: config.id,
          description: config.config?.description || `HTTP signal for ${config.id}`,
          provider: "http" as const,
          path: config.config?.path,
          method: config.config?.method,
        });

      case "timer":
      case "schedule":
      case "cron":
      case "cron-scheduler":
        return new ProviderClass({
          id: config.id,
          description: config.config?.description || `Timer signal for ${config.id}`,
          provider: config.provider,
          schedule: config.config?.schedule,
          timezone: config.config?.timezone,
        });

      case "cli":
        return new ProviderClass({
          id: config.id,
          description: config.config?.description || `CLI signal for ${config.id}`,
          provider: "cli" as const,
          command: config.config?.command,
          args: config.config?.args,
          flags: config.config?.flags,
        });

      default:
        return new ProviderClass(config);
    }
  }

  static registerBuiltinProviders(): void {
    // This method now does nothing but is kept for compatibility
    // All providers are available through static imports
  }
}
```

**Risk**: Medium - changes core registry behavior but preserves interface

### Phase 2: Provider Consolidation (Medium Risk)

#### 2.1 Move CLI Provider

**Goal**: Consolidate all providers in signals package

**Steps**:

1. Copy `src/core/providers/builtin/cli-signal.ts` to `packages/signals/src/providers/cli-signal.ts`
2. Update provider map import:
   ```typescript
   import { CliSignalProvider } from "./cli-signal.ts";
   ```
3. Update tests to import from new location
4. Remove old CLI provider file

**Risk**: Medium - requires coordinated test updates

#### 2.2 Update Package Exports

**Goal**: Ensure all providers are properly exported

**Implementation**:

```typescript
// packages/signals/src/providers/index.ts
export { CliSignalProvider } from "./cli-signal.ts";
// ... other existing exports

// packages/signals/src/index.ts
export * from "./providers/index.ts";
export { PROVIDER_CLASSES } from "./providers/provider-map.ts";
```

### Phase 3: Testing and Validation (Critical)

#### 3.1 Update Test Structure

**Current state**:

- `tests/unit/providers/cli-signal.test.ts` - tests CLI provider implementation
- `tests/unit/providers/cli-signal-registry.test.ts` - tests registry integration
- No CLI provider tests in `packages/signals/tests/`

**Required changes**:

1. Move CLI provider tests to `packages/signals/tests/unit/providers/`
2. Update import paths in all tests
3. Create integration tests for static provider map

#### 3.2 Validation Checklist

- [ ] All existing tests pass
- [ ] No dynamic imports remain in registry code
- [ ] Static provider map includes all providers
- [ ] Registry initialization works without errors
- [ ] Signal processing works end-to-end
- [ ] Performance improvement measurable

## Migration Guide

### Breaking Changes

#### 1. Import Path Changes

**Before**:

```typescript
import { ProviderRegistry } from "packages/signals/src/registry.ts";
```

**After**:

```typescript
import { ProviderRegistry } from "@atlas/signals";
// or
import { ProviderRegistry } from "src/core/providers/registry.ts";
```

#### 2. CLI Provider Location

**Before**:

```typescript
import { CliSignalProvider } from "src/core/providers/builtin/cli-signal.ts";
```

**After**:

```typescript
import { CliSignalProvider } from "@atlas/signals";
```

#### 3. Provider Registration

**Before**:

```typescript
registry.registerFactory("custom", async (config) => {
  const { CustomProvider } = await import("./custom-provider.ts");
  return new CustomProvider(config);
});
```

**After**:

```typescript
// Add to provider map instead:
import { CustomProvider } from "./custom-provider.ts";

export const PROVIDER_CLASSES = {
  // ... existing providers
  "custom": CustomProvider,
} as const;
```

### API Compatibility

**Preserved**:

- `ProviderRegistry.getInstance()` - singleton access
- `registry.loadFromConfig(config)` - async provider loading
- `ProviderRegistry.registerBuiltinProviders()` - no-op for compatibility

**Enhanced**:

- Faster startup (no dynamic imports)
- Better IDE support (static analysis)
- Consistent provider organization

## Risk Assessment

### High Risk

- **Registry behavior changes**: Core functionality modifications
- **Test coordination**: Multiple test files need updates
- **Circular dependency**: Package dependency relationships

### Medium Risk

- **Provider relocation**: Moving CLI provider between packages
- **Import path updates**: Multiple files need import changes

### Low Risk

- **File deletion**: Removing duplicate registry
- **Static provider map**: Additive change

## Rollback Strategy

### Immediate Rollback

1. Revert to previous git commit
2. Restore duplicate registry file
3. Restore original import paths

### Selective Rollback

1. Keep static provider map (beneficial change)
2. Revert registry behavior changes
3. Restore dynamic imports temporarily

## Success Metrics

### Performance

- **Startup time**: Measure workspace initialization time
- **Bundle size**: Compare before/after bundle sizes
- **Memory usage**: Monitor registry memory footprint

### Code Quality

- **Duplication**: Zero duplicate registry classes
- **Import consistency**: All imports use static pattern
- **Test coverage**: Maintain or improve test coverage

### Developer Experience

- **IDE support**: Better autocomplete and navigation
- **Build times**: Faster type checking
- **Error messages**: Earlier error detection

## Timeline

### Phase 1 (1-2 days)

- Remove duplicate registry
- Create static provider map
- Update main registry

### Phase 2 (2-3 days)

- Move CLI provider
- Update package exports
- Test integration

### Phase 3 (2-3 days)

- Update all tests
- Performance validation
- Documentation updates

**Total Estimated Time**: 5-8 days

## Future Considerations

### Extensibility

- **Plugin system**: If external providers are needed, implement proper plugin architecture
- **Configuration validation**: Add schema validation for provider configs
- **Provider lifecycle**: Implement proper setup/teardown if needed

### Architecture

- **Dependency injection**: Replace singleton pattern for better testability
- **Provider interfaces**: Standardize provider interfaces
- **Error handling**: Improve error messages and recovery

## References

### Codebase Guidelines

- `CLAUDE.md`: "STRONGLY PREFER static imports (at the top of modules)"
- `CLAUDE.md`: "Avoid using barrel imports (index.ts files that re-export other modules)"

### Current Files

- `src/core/providers/registry.ts` - Main registry implementation
- `packages/signals/src/registry.ts` - Duplicate registry (to be removed)
- `src/core/workspace-runtime-machine.ts:247` - Primary usage point
- `tests/unit/providers/cli-signal-registry.test.ts` - Registry integration tests

### Dependencies

- `@atlas/signals` - Signals package
- `src/core/providers/types.ts` - Provider interfaces
- `packages/signals/src/providers/` - Provider implementations
