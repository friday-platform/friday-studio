# Config V2 Strict Object Analysis

## Executive Summary

You are correct in your suspicion that Atlas config v2 schemas are ignoring extraneous properties
rather than erroring on them. All schemas in `@packages/config/src/` use `z.object()` instead of
`z.strictObject()`, which means:

1. **Extra properties are silently stripped** from parsed configurations
2. **Configuration bloat goes undetected** - old or misnamed properties persist without validation
   errors
3. **Typos in property names are ignored** - potentially causing features to not work as expected
4. **Schema evolution is less disciplined** - developers may add properties without updating schemas

## Current State Analysis

### Schema Implementation Review

All config v2 schemas consistently use `z.object()`:

- **`workspace.ts`**: `WorkspaceConfigSchema = z.object({...})`
- **`base.ts`**: All schemas use `z.object()` (e.g., `WorkspaceIdentitySchema`, `ConditionSchema`)
- **`agents.ts`**: All agent schemas use `z.object()` (e.g., `BaseAgentConfigSchema`)
- **`jobs.ts`**: All job schemas use `z.object()` (e.g., `JobSpecificationSchema`)
- **`atlas.ts`**: All atlas schemas use `z.object()` (e.g., `SupervisorConfigSchema`)
- **`signals.ts`**: All signal schemas use `z.object()` (e.g., `HTTPSignalConfigSchema`)
- **`mcp.ts`**: All MCP schemas use `z.object()` (e.g., `MCPServerConfigSchema`)
- **`memory.ts`**: All memory schemas use `z.object()` (e.g., `WorkspaceMemoryConfigSchema`)

### Current Behavior

With `z.object()`, this configuration would **silently succeed**:

```yaml
version: "1.0"
workspace:
  name: "My Workspace"
  description: "A workspace"
  # This typo would be ignored:
  descrption: "Duplicate with typo"
  # This old property would be ignored:
  legacy_property: "old value"
  # This experimental property would be ignored:
  experimental_feature: true
```

The parsed result would only contain the valid properties, with typos and extra properties silently
removed.

### Validation Test Analysis

The current validation test in `integration-tests/validate-examples.test.ts` only catches:

- **Missing required properties**
- **Invalid property types**
- **Invalid enum values**
- **Constraint violations** (e.g., min/max values)

It does **NOT** catch:

- **Extra properties** (typos, legacy properties, experimental features)
- **Misspelled property names**
- **Configuration bloat**

## Recommendation: Migrate to `z.strictObject()`

### Benefits of `z.strictObject()`

1. **Stricter validation** - Catches configuration typos and bloat
2. **Better schema discipline** - Forces explicit schema updates for new properties
3. **Cleaner configurations** - Prevents accumulation of unused properties
4. **Better error messages** - Users get explicit feedback about invalid properties
5. **Alignment with user expectations** - Most users expect strict validation

### Implementation Strategy

#### Complete Migration Approach

Replace all `z.object()` with `z.strictObject()` across all config v2 schemas:

```typescript
// Replace all z.object() with z.strictObject()
export const WorkspaceConfigSchema = z.strictObject({
  version: z.literal("1.0"),
  workspace: WorkspaceIdentitySchema,
  // ... rest of schema
});
```

#### Configuration Cleanup

1. **Run validation tests** to identify failing configurations
2. **Clean up all extra properties** by either:
   - Removing them if obsolete
   - Adding them to schemas if valid
3. **Fix typos** in property names
4. **Update all workspace.yml files** to pass strict validation

### All Schemas Migrated to Strict Validation

All config v2 schemas will be migrated to `z.strictObject()`:

1. **`WorkspaceConfigSchema`** - Root configuration schema
2. **`WorkspaceIdentitySchema`** - Core workspace identity
3. **`JobSpecificationSchema`** - Job definitions
4. **`WorkspaceAgentConfigSchema`** - Agent configurations
5. **`WorkspaceSignalConfigSchema`** - Signal definitions
6. **`MCPServerConfigSchema`** - MCP server configuration
7. **`WorkspaceMemoryConfigSchema`** - Memory configuration
8. **`FederationConfigSchema`** - Federation settings
9. **`AgentContextSchema`** - Agent context
10. **`FileContextSchema`** - File context
11. **All other schemas** - Complete migration for consistency

### Implementation Example

```typescript
// Before
export const WorkspaceConfigSchema = z.object({
  version: z.literal("1.0"),
  workspace: WorkspaceIdentitySchema,
  server: ServerConfigSchema.optional(),
  // ... rest
});

// After
export const WorkspaceConfigSchema = z.strictObject({
  version: z.literal("1.0"),
  workspace: WorkspaceIdentitySchema,
  server: ServerConfigSchema.optional(),
  // ... rest - all properties must be explicitly defined
});
```

### Migration Approach

1. **Run validation tests** to identify all configurations with extra properties
2. **Update all schemas** to use `z.strictObject()` simultaneously
3. **Clean up all workspace.yml files** to pass strict validation
4. **Fix any validation errors** that surface during testing

### Testing Strategy

1. **Create test configurations** with extra properties
2. **Run validation tests** with both `z.object()` and `z.strictObject()`
3. **Compare results** to understand impact
4. **Test migration path** with real workspace configurations

### Implementation Plan

#### Step 1: Analysis Phase (1 day)

1. Run validation tests with `z.strictObject()` on all existing configs
2. Catalog all extra properties found
3. Classify properties as: typos, obsolete, or legitimate-but-missing-from-schema

#### Step 2: Complete Migration (2 days)

1. Update ALL schemas to use `z.strictObject()`
2. Add missing legitimate properties to schemas
3. Remove obsolete properties from all workspace.yml files
4. Fix typos in property names
5. Update example configurations

#### Step 3: Testing and Validation (1 day)

1. Run full validation test suite
2. Test with all workspace configurations
3. Verify error messages are clear and actionable

#### Step 4: Documentation Update (1 day)

1. Update configuration documentation
2. Update error handling documentation

## Conclusion

The migration to `z.strictObject()` is a worthwhile improvement that will:

- Catch configuration errors that currently go unnoticed
- Improve configuration quality across the codebase
- Provide better user experience through clearer validation

The implementation will be done as a complete migration, updating all schemas and workspace.yml
files simultaneously.

**Next Steps**: Run the analysis phase to understand the current impact, then proceed with the
complete migration of all schemas and configuration files.
