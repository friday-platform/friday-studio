# WorkspaceManager Tests

These tests verify the core functionality of the WorkspaceManager without using mocks or stubs.

## Test Coverage

✅ **System workspace registration** - Verifies that system workspaces are properly registered from
build-time imports ✅ **Register filesystem workspace** - Tests registering workspaces from
filesystem paths ✅ **Workspace find operations** - Tests finding workspaces by ID, name, and path
✅ **Load workspace configuration** - Works for both system and filesystem workspaces ✅ **Workspace
deletion** - Tests deleting workspaces and system workspace protection ✅ **Runtime management** -
Tests runtime registration and tracking ✅ **List with filtering** - Tests listing workspaces with
various filters (system/user, by status)

## Running Tests

```bash
deno test --allow-all --no-check packages/core/tests/workspace-manager.test.ts
```

## Key Test Insights

1. **System workspaces** are automatically registered from `@atlas/system/workspaces`
2. **Workspace configurations** are validated using ConfigLoader with strict schema validation
3. **System workspaces** cannot be deleted without `force: true`
4. **List operations** exclude system workspaces by default

## Test Workspace Configuration

The test workspace at `fixtures/test-workspace/workspace.yml` includes:

- HTTP signal with proper config
- Job with condition-based triggers
- LLM agent with required prompt field

## Implementation Notes

- Uses in-memory KV storage for isolation
- Real filesystem operations for workspace registration
- Actual configuration loading and validation
- No mocks or stubs - tests real functionality
- Logger output disabled during tests via `DENO_TESTING` environment variable to prevent resource
  leaks
