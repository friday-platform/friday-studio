# Atlas Config V2 Tests

This directory contains comprehensive tests for the Atlas configuration v2 schemas and validation
system.

## Running Tests

Run all tests:

```bash
deno test tests-v2/ --allow-read
```

Run specific test file:

```bash
deno test tests-v2/config-parsing-test.ts --allow-read
```

## Test Coverage

### config-parsing-test.ts

- Validates that the comprehensive workspace and atlas examples parse correctly
- Tests schema validation for all configuration sections
- Verifies signal payload validation with JSON schemas
- Tests type discrimination for agent tagged unions
- Validates cross-references between agents, jobs, and signals

### config-merge-test.ts

- Tests merging behavior between workspace.yml and atlas.yml
- Validates that workspace config takes precedence over atlas config
- Tests complex tool configuration merging
- Verifies agent, signal, and job merging from both configs
- Tests federation and memory configuration handling

### json-schema-validation-test.ts

- Tests JSON Schema to Zod conversion for signal payload validation
- Covers all JSON Schema types: string, number, boolean, object, array, null
- Tests enum conversion and nested schemas
- Validates complex business logic payloads (e.g., order processing)
- Tests edge cases in schema conversion

### edge-cases-test.ts

- Tests invalid configuration structures and error handling
- Validates required fields and type constraints
- Tests circular references and complex scenarios
- Verifies ConfigLoader error handling
- Tests helper functions (getJob, getSignal, getAgent)

## Key Test Scenarios

1. **Comprehensive Example Validation**: Both example files from docs/ are fully parsed and
   validated
2. **System Signal Validation**: System signals only allowed in system workspaces
3. **Cross-Reference Validation**: Jobs must reference existing agents and signals
4. **Merge Behavior**: Atlas config provides defaults, workspace config overrides
5. **Signal Payload Validation**: Runtime validation using JSON schemas
6. **Type Safety**: Tagged unions for agents work correctly with TypeScript

## Notes

- Tests use mock adapters to avoid file system dependencies
- All tests are isolated and can run in parallel
- Tests cover both happy paths and error scenarios
- Edge cases include circular references, missing fields, and invalid values
