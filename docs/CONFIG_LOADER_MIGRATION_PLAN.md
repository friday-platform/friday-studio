# Config Loader Refactor & Monorepo Migration - Architecture Decision Record

## Context

The configuration loading system was tightly coupled to filesystem operations and scattered across
the codebase. This made it difficult to:

- Test configuration logic in isolation
- Support alternative configuration sources (databases, remote config services)
- Maintain clear separation of concerns
- Reuse configuration logic across different contexts

## Decision

We migrated the configuration system into the monorepo structure with clear architectural
boundaries:

1. **`@atlas/config` package** - Contains all schemas, types, and validation logic
2. **`@atlas/storage` package** - Provides the adapter pattern for configuration sources
3. **Dependency injection** - ConfigLoader accepts adapters rather than performing I/O directly

## Key Architectural Decisions

### 1. Adapter Pattern for Configuration Sources

**Why**: The adapter pattern allows us to:

- Test configuration logic without filesystem dependencies
- Support multiple configuration sources (filesystem, S3, databases, etc.)
- Mock adapters for unit testing
- Keep the ConfigLoader focused on validation and merging logic

### 2. Separate Packages for Config and Storage

**Why**: Clear separation of concerns:

- `@atlas/config` owns schemas, types, and validation logic
- `@atlas/storage` owns I/O operations and data persistence
- No circular dependencies between packages
- Each package can evolve independently

### 3. TypeScript for Configuration Defaults

**Decision**: Use TypeScript files for supervisor defaults instead of YAML

**Why**:

- Compile-time type safety
- Better IDE support and autocomplete
- Can import and compose configuration programmatically
- Reduces runtime parsing overhead

### 4. Supervisor Defaults Typing

**Decision**: Created `SupervisorDefaultsSchema` with proper Zod validation

**Why**:

- Eliminated `any` types throughout the codebase
- Ensures supervisor configuration consistency
- Enables proper type inference in dependent code

### 5. Consolidated MCP Schemas

**Decision**: Merged all MCP-related schemas into main schemas.ts file

**Why**:

- Single source of truth for all configuration schemas
- Reduces file sprawl
- Easier to maintain related schemas together

## Testing Approach

### Mock Adapter Pattern

Created `MockConfigAdapter` for unit testing the ConfigLoader without filesystem dependencies. This
allows:

- Testing validation logic in isolation
- Simulating error conditions
- Fast test execution
- Predictable test data

### Type Safety in Tests

**Challenge**: The `ConfigurationAdapter` correctly returns `unknown` values since it's a generic
YAML loader.

**Solution**: Use object equality assertions (`toEqual`) instead of type assertions:

- Tests verify behavior, not implementation
- Maintains type safety without `any` casts
- Clear and readable test expectations

### Resource Leak Prevention

**Issue**: Tests were leaking file handles and async operations.

**Solutions**:

1. Set `DENO_TESTING=true` environment variable to disable logger file operations
2. Create and clean up temp directories per test, not globally
3. Remove unnecessary `async` keywords from methods without `await`

## Open Work

### Future Enhancements

1. **Additional Adapters**:

   - S3ConfigAdapter for cloud storage
   - DatabaseConfigAdapter for dynamic configuration
   - RemoteConfigAdapter for configuration services

2. **Configuration Versioning**:

   - Schema migration support
   - Backward compatibility handling
   - Version-specific validation

3. **Performance Optimizations**:
   - Configuration caching layer
   - Lazy loading for large job directories
   - Watch mode for configuration changes

### Known Limitations

1. Supervisor defaults are currently bundled with the storage adapter
2. No support for configuration inheritance or overlays
3. Limited error recovery strategies

## Lessons Learned

1. **Type boundaries are important** - The adapter returning `unknown` is correct; typing happens at
   validation
2. **Test isolation matters** - Global state in tests leads to flaky results
3. **Clear package boundaries** - Helped identify and fix circular dependencies early
4. **Incremental migration works** - We maintained backward compatibility throughout
