# Atlas Monorepo Migration Plan

## Overview

This document outlines the plan for migrating the Atlas codebase from its current single-package
structure to a Deno workspace monorepo. The migration will improve code organization, enable better
separation of concerns, and facilitate independent versioning and deployment of different
components.

## Proposed Structure

```
atlas-monorepo/
├── deno.json                    # Root workspace configuration
├── examples/                    # Example workspaces and configurations
├── integration-tests/           # Cross-package integration tests
├── apps/                        # User-facing applications
│   ├── cli/                     # Atlas CLI application
│   │   ├── deno.json
│   │   ├── src/
│   │   ├── components/        # CLI-specific UI components
│   │   ├── tests/
│   │   └── README.md
│   └── atlasd/                  # Atlas daemon server
│       ├── deno.json
│       ├── src/
│       ├── tests/
│       └── README.md
└── packages/                    # Shared library code
    ├── core/                    # Core Atlas functionality
    │   ├── deno.json
    │   ├── src/
    │   ├── tests/
    │   └── README.md
    ├── types/                   # Shared type definitions
    │   ├── deno.json
    │   ├── src/
    │   └── README.md
    ├── storage/                 # Storage adapters
    │   ├── deno.json
    │   ├── src/
    │   ├── tests/
    │   └── README.md
    ├── mcp/                     # MCP integration
    │   ├── deno.json
    │   ├── src/
    │   ├── tests/
    │   └── README.md
    ├── agents/                  # Agent system
    │   ├── deno.json
    │   ├── src/
    │   ├── tests/
    │   └── README.md
    ├── library/                 # Atlas library functionality
    │   ├── deno.json
    │   ├── src/
    │   ├── tests/
    │   └── README.md
    ├── client/                  # HTTP client for daemon communication
    │   ├── deno.json
    │   ├── src/
    │   ├── tests/
    │   └── README.md
    ├── config/                  # Configuration schemas and defaults
    │   ├── deno.json
    │   ├── src/
    │   ├── tests/
    │   └── README.md
    ├── memory/                  # Memory tools and adapters
    │   ├── deno.json
    │   ├── src/
    │   ├── tests/
    │   └── README.md
    └── utils/                   # Shared utilities
        ├── deno.json
        ├── src/
        ├── tests/
        └── README.md
```

## Package Breakdown

### Apps

#### `apps/cli` - Atlas CLI

- **Current Location**: `src/cli/`, `src/cli.tsx`
- **Responsibilities**:
  - Command-line interface
  - Interactive TUI
  - Command parsing and execution
  - User interaction
  - CLI-specific UI components
- **Dependencies**: `@atlas/types`, `@atlas/client`, `@atlas/utils`
- **Note**: CLI should NOT depend on `@atlas/core` - all communication goes through HTTP client

#### `apps/atlasd` - Atlas Daemon

- **Current Location**: `src/core/atlas-daemon.ts`, `src/core/workspace-server.ts`
- **Responsibilities**:
  - HTTP server
  - Workspace runtime management
  - Signal processing
  - API endpoints
- **Dependencies**: `@atlas/core`, `@atlas/types`, `@atlas/storage`, `@atlas/agents`

### Packages

#### `packages/core` - Core Atlas Functionality

- **Current Location**: Most of `src/core/` except daemon-specific files
- **Responsibilities**:
  - Workspace management
  - Session supervision
  - Signal processing
  - Execution engine
  - Configuration loading
- **Exports**:
  - WorkspaceRuntime
  - WorkspaceSupervisor
  - SessionSupervisor
  - SignalProcessor
  - ConfigLoader

#### `packages/types` - Shared Type Definitions

- **Current Location**: `src/types/`, type definitions from other modules
- **Responsibilities**:
  - Common interfaces
  - Type definitions
  - Enums and constants
- **Exports**:
  - Agent types
  - Core types
  - Vector search types
  - Configuration types

#### `packages/storage` - Storage Adapters

- **Current Location**: `src/storage/`, `src/core/storage/`
- **Responsibilities**:
  - Storage abstraction
  - Various adapter implementations
  - Memory persistence
- **Exports**:
  - Storage interfaces
  - KV storage implementations
  - Memory storage adapters
  - Library storage adapters

#### `packages/mcp` - MCP Integration

- **Current Location**: `src/core/mcp/`, `src/core/agents/mcp/`
- **Responsibilities**:
  - MCP server management
  - MCP proxy functionality
  - MCP tool integration
- **Exports**:
  - MCPManager
  - MCPProxy
  - MCPServer implementations

#### `packages/agents` - Agent System

- **Current Location**: `src/core/agents/`, `src/core/agent-*.ts`
- **Responsibilities**:
  - Agent base classes
  - Agent supervision
  - Remote agent support
  - Agent loading
- **Exports**:
  - BaseAgent
  - AgentSupervisor
  - RemoteAgent
  - AgentLoader

#### `packages/library` - Atlas Library

- **Current Location**: `src/core/library/`
- **Responsibilities**:
  - Template management
  - Prompt templates
  - Library storage
- **Exports**:
  - AtlasLibrary
  - TemplateEngine
  - LibraryStorage

#### `packages/client` - Atlas HTTP Client

- **Current Location**: `src/cli/utils/daemon-client.ts`
- **Responsibilities**:
  - HTTP client for daemon communication
  - API type definitions
  - Error handling for daemon connectivity
  - Request/response abstraction
- **Exports**:
  - DaemonClient
  - DaemonClientOptions
  - API type definitions
  - Error types

#### `packages/config` - Configuration Management

- **Current Location**: `src/config/`, configuration-related files from core
- **Responsibilities**:
  - Configuration schemas
  - Default configurations
  - Configuration validation
  - Workspace initialization defaults
- **Dependencies**: `@atlas/types`, `@atlas/storage`
- **Exports**:
  - Configuration schemas
  - Default configurations
  - Configuration validators

#### `packages/memory` - Memory Tools

- **Current Location**: `src/tools/`, memory-related code from core
- **Responsibilities**:
  - Memory management tools
  - Memory adapters
  - Memory utilities
- **Dependencies**: `@atlas/types`, `@atlas/storage`
- **Exports**:
  - Memory tools
  - Memory adapters

#### `packages/utils` - Shared Utilities

- **Current Location**: `src/utils/`, `src/cli/utils/`, `src/core/utils/`
- **Responsibilities**:
  - Common utilities
  - Logging
  - Path management
  - ID generation
- **Exports**:
  - Logger
  - Path utilities
  - ID generator
  - Other shared utilities

## Migration Steps

### Phase 1: Infrastructure Setup

1. Create root `deno.json` with workspace configuration
2. Set up initial package directory structure
3. Configure workspace settings
4. Set up integration testing infrastructure

### Phase 2: Incremental Package Extraction (Order matters!)

1. **Extract `packages/types`** (no dependencies)
   - Move type definitions
   - Update imports across codebase

2. **Extract `packages/utils`** (depends on types)
   - Move utility functions
   - Update imports

3. **Extract `packages/storage`** (depends on types, utils)
   - Move storage adapters
   - Create clean interfaces

4. **Extract `packages/client`** (depends on types)
   - Move daemon client from `src/cli/utils/daemon-client.ts`
   - Extract API type definitions
   - Create clean HTTP abstraction

5. **Extract `packages/config`** (depends on types, storage)
   - Move configuration schemas and defaults
   - Extract validation logic
   - Set up workspace initialization defaults

6. **Extract `packages/memory`** (depends on types, storage)
   - Move memory tools from `src/tools/`
   - Extract memory-related code from core
   - Create clean interfaces

7. **Extract `packages/mcp`** (depends on types, utils)
   - Move MCP-related code
   - Ensure clean separation

8. **Extract `packages/library`** (depends on types, utils, storage)
   - Move library functionality
   - Update dependencies

9. **Extract `packages/agents`** (depends on types, utils, mcp)
   - Move agent system
   - Maintain worker isolation

10. **Extract `packages/core`** (depends on all above except client)
    - Move core functionality
    - Ensure clean interfaces

11. **Extract `apps/atlasd`** (depends on core and others)
    - Move daemon-specific code
    - Set up proper entry points

12. **Extract `apps/cli`** (depends on types, client, utils)
    - Move CLI code
    - Keep UI components within CLI
    - Maintain command structure

### Phase 3: Continuous Integration

Throughout the migration:

1. Update import paths as packages are extracted
2. Run tests after each extraction
3. Add integration tests for new package boundaries
4. Update documentation incrementally
5. Keep existing functionality working at all times

## Workspace Configuration

### Root `deno.json`

```json
{
  "workspace": ["./apps/*", "./packages/*"],
  "compilerOptions": {
    "lib": ["deno.window", "deno.worker", "deno.unstable", "dom", "dom.iterable"],
    "jsx": "react-jsx",
    "jsxImportSource": "react"
  },
  "unstable": ["broadcast-channel", "worker-options", "otel", "kv"]
}
```

### Package `deno.json` Example

```json
{
  "name": "@atlas/core",
  "version": "1.0.0",
  "exports": "./mod.ts"
}
```

## Benefits

1. **Improved Code Organization**: Clear separation between apps and packages
2. **Architectural Integrity**: CLI communicates only via HTTP client, maintaining clean separation
3. **Better Testing**: Isolated unit tests per package plus integration tests
4. **Reusability**: Packages can be used independently
5. **Faster Development**: Parallel development on different packages
6. **Clear Dependencies**: Explicit dependencies between packages
7. **Better Build Times**: Only rebuild changed packages
8. **Future UI Support**: Clean client/server separation enables future web UI development

## Considerations

1. **Import Path Updates**: All imports will need to be updated to use workspace references
2. **Testing Strategy**: Need to maintain both unit tests per package and integration tests
3. **Deployment**: Update deployment scripts to handle monorepo structure
4. **Developer Experience**: Ensure smooth development workflow with proper tooling
5. **Documentation**: Keep documentation up-to-date throughout migration
6. **UI Components**: Currently keeping UI components within CLI since they're CLI-specific. When we
   add web UI or other interfaces, we can extract shared components to a separate package
7. **Client Package**: The client package enables clean separation between frontend (CLI/UI) and
   backend (daemon), supporting future UI development

## Success Criteria

1. All existing functionality works without regression
2. Clear separation of concerns between packages
3. All tests pass (unit and integration)
4. Improved developer experience
5. Documentation is complete and accurate
6. CI/CD pipelines work with new structure

## Migration Tracker

### Completed

- [x] Infrastructure setup
- [x] Initial workspace configuration
- [x] Package directory structure (config, storage stubs created)

### In Progress

- [ ] Migrating code to packages

### Package Extraction Status

- [ ] `@atlas/types`
- [ ] `@atlas/utils`
- [ ] `@atlas/storage` (stub created, ready for migration)
- [ ] `@atlas/client`
- [ ] `@atlas/config` (stub created, ready for migration)
- [ ] `@atlas/memory`
- [ ] `@atlas/mcp`
- [ ] `@atlas/library`
- [ ] `@atlas/agents`
- [ ] `@atlas/core`
- [ ] `@atlas/atlasd` (app)
- [ ] `@atlas/cli` (app)

### Post-Migration

- [ ] Remove old directory structure
- [ ] Update all documentation
- [ ] Set up CI/CD for monorepo
- [ ] Comprehensive integration test suite

## Decisions Made

Based on feedback, the following decisions have been made:

1. **Package Publishing**: Not publishing to JSR at this time
2. **Daemon Architecture**: Daemon remains as a separate app (good separation)
3. **Configuration Files**: Will serve as defaults for workspace initialization, extracted to
   `@atlas/config` package
4. **Memory Tools**: Extracted from `tools/` directory into separate `@atlas/memory` package
5. **Config Package**: Created `@atlas/config` package for schemas and defaults (depends on storage)

## Additional Decisions

Based on further feedback:

1. **Examples**: Will remain in root directory (not a separate package)
2. **Integration Testing**: Cross-package tests will live in `integration-tests/` at the top level
3. **Versioning Strategy**: Keep all packages in sync initially (same version numbers)
4. **CLI Architecture**: CLI should NOT depend on `@atlas/core` - all communication through HTTP
   client to maintain proper architectural encapsulation
