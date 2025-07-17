# Integration Tests Inventory

This document provides a comprehensive overview of all integration tests in the Atlas project,
organized by type and location.

## Test Categories

### 1. End-to-End Integration Tests (`/integration-tests/`)

These tests verify complete workflows and system interactions:

- **`telemetry-integration.test.ts`** - OpenTelemetry implementation testing with real-world
  scenarios and cross-worker trace propagation
- **`workspace-add-e2e.test.ts`** - Complete workspace add functionality including file system
  operations and daemon interaction
- **`workspace-add-yaml-name-e2e.test.ts`** - Workspace add functionality with YAML name handling
- **`atlas-client-e2e.test.ts`** - Complete flow from CLI modules through AtlasClient to daemon API
- **`config-loader-migration.test.ts`** - Configuration loading and migration processes
- **`configuration-architecture.test.ts`** - Configuration architecture with atlas.yml vs
  workspace.yml separation
- **`agent-tool-format-compatibility.test.ts`** - Agent tool format compatibility verification
- **`reasoning-llm-simple.test.ts`** - Simple ReasoningMachine integration with real LLM
- **`reasoning-llm-tools.test.ts`** - ReasoningMachine integration with tool usage
- **`config-flow.integration.test.ts`** - Configuration flow validation through actor hierarchy
  (WorkspaceRuntime → WorkspaceSupervisor → SessionSupervisor → AgentExecutionActor)

### 2. Remote Agents Integration Tests (`/integration-tests/remote-agents/`)

- **`README.md`** - Documentation for remote agents integration tests
- **`agents.ts`** - Agent definitions for remote agents integration tests
- **`types.ts`** - Type definitions for remote agents integration tests

### 3. Mock Services (`/integration-tests/mocks/`)

Supporting mock services for integration tests:

- **`echo-mcp-server.ts`** - Echo MCP server for testing
- **`file-tools-mcp-server.ts`** - File tools MCP server for testing
- **`weather-mcp-server.ts`** - Weather MCP server for testing

### 4. Package-Level Integration Tests

Integration tests within specific packages:

- **`packages/signals/tests/integration/signal-trigger-multi-workspace.test.ts`** - Signal trigger
  multi-workspace functionality
- **`packages/openapi-client/tests/integration.test.ts`** - OpenAPI client integration with real
  Atlas daemon
- **`packages/cron/tests/timer-signal-workspace-integration.test.ts`** - Timer signal workspace
  runtime integration

### 5. Cross-Package Integration Tests

Tests that verify interactions between multiple packages:

- **`src/cli/modules/sessions/fetcher.test.ts`** - Sessions fetcher integration with @atlas/client
- **`src/cli/modules/library/fetcher.test.ts`** - Library fetcher integration with @atlas/client
- **`apps/atlasd/tests/health.test.ts`** - Health check integration with real Atlas daemon
- **`src/utils/version-checker.integration.test.ts`** - Version checker with real API calls

## Test Execution

### Commands

- **`deno task test`** - Run all tests (unit + integration)
- **`deno task test:unit`** - Run only unit tests (excludes integration-tests/)
- **`deno task test:integration`** - Run only integration tests from all locations

### CI/CD Integration

- **Unit Tests**: Run in `.github/workflows/test.yml` on every push/PR
- **Integration Tests**: Run in `.github/workflows/integration-tests.yml` on every push/PR

## Test Characteristics

### Real System Integration

- Spin up real Atlas daemons
- Create temporary workspaces
- Test full end-to-end workflows

### External Service Integration

- Real API calls (version checker, LLM services)
- Network communication verification
- HTTP communication between components

### Cross-Package Testing

- Import from multiple @atlas packages
- Verify inter-package compatibility
- Test package boundary interactions

### File System Operations

- Create/modify real files and directories
- Configuration file loading and validation
- Workspace initialization and management

### Worker Communication

- BroadcastChannel communication verification
- MessagePort communication testing
- Worker lifecycle management

### Signal and Job Processing

- Complete signal-to-job execution workflows
- Multi-workspace signal processing
- Timer-based signal triggering

## Guidelines

1. **Integration tests should be comprehensive** - Test complete workflows, not individual functions
2. **Use real services where possible** - Avoid excessive mocking in integration tests
3. **Test error conditions** - Verify proper error handling in integration scenarios
4. **Keep tests isolated** - Each test should be independent and clean up after itself
5. **Use descriptive test names** - Clearly indicate what integration is being tested
6. **Test cross-package interactions** - Verify that package boundaries work correctly
7. **Include performance considerations** - Integration tests should complete within reasonable time
   limits
