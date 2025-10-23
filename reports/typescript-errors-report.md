# TypeScript & Lint Analysis Report

**Generated:** 2025-10-23T04:08:07.720Z

**Total Issues:** 1 (0 type errors, 0 deno lint violations, 1 biome violations)

## Summary Statistics

### TypeScript Errors

- **Total errors:** 0
- **Unique error types:** 0
- **Files with errors:** 0

### Deno Lint Violations

- **Total violations:** 0
- **Unique rules violated:** 0
- **Files with violations:** 0

### Biome Violations

- **Total violations:** 1
- **Errors:** 1
- **Warnings:** 0
- **Unique rules violated:** 1
- **Files with violations:** 1

## TypeScript Error Types Breakdown

No TypeScript errors found.

## Deno Lint Rules Breakdown

No lint violations found.

## Biome Rules Breakdown

| Rule Name                | Count | Percentage | Severity Distribution |
| ------------------------ | ----- | ---------- | --------------------- |
| style/noNonNullAssertion | 1     | 100.0%     | 1E                    |

## Files with Most Issues

| File                                                      | Type Errors | Deno Lint | Biome | Total |
| --------------------------------------------------------- | ----------- | --------- | ----- | ----- |
| packages/core/src/agent-server/agent-execution-machine.ts | 0           | 0         | 1     | 1     |

## Issues by Project

| Project       | Type Errors | Deno Lint | Biome | Total |
| ------------- | ----------- | --------- | ----- | ----- |
| packages/core | 0           | 0         | 1     | 1     |

## Workspace Dependency Graph

### Dependency Analysis

| Package                 | Dependencies                                                                                  | Dependents                                                                                                                | Complexity Score |
| ----------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| utils                   | none                                                                                          | web-client, atlasd, core, logger, memory, config, mcp-server, bundled-agents, storage, system, diagnostics, client, evals | 26               |
| core                    | config, logger, mcp, utils, agent-sdk, bundled-agents, oapi-client, client, memory            | web-client, atlasd, agent-sdk, mcp-server, bundled-agents, system, client, evals                                          | 25               |
| logger                  | utils                                                                                         | atlasd, agent-sdk, core, memory, workspace, mcp-server, mcp, bundled-agents, system, fs-watch, diagnostics, cron          | 25               |
| atlasd                  | core, logger, utils, config, storage, agent-sdk, cron, mcp-server, memory, workspace, signals | mcp-server, mcp, client, openapi-client, evals                                                                            | 21               |
| client                  | utils, atlasd, core, oapi-client                                                              | web-client, core, mcp-server, system, diagnostics, evals                                                                  | 16               |
| config                  | utils, agent-sdk, storage                                                                     | atlasd, core, workspace, mcp-server, bundled-agents, system                                                               | 15               |
| agent-sdk               | logger, core                                                                                  | atlasd, core, config, bundled-agents, system, evals                                                                       | 14               |
| memory                  | storage, logger, utils                                                                        | atlasd, core, storage, system, memory_manager                                                                             | 13               |
| workspace               | config, logger, storage, system, fs-watch                                                     | atlasd, diagnostics, cron, memory_manager                                                                                 | 13               |
| system                  | agent-sdk, client, core, utils, config, bundled-agents, logger, memory, oapi-client           | workspace, evals                                                                                                          | 13               |
| bundled-agents          | agent-sdk, core, logger, utils, config                                                        | core, system, evals                                                                                                       | 11               |
| storage                 | memory, utils                                                                                 | atlasd, memory, config, workspace                                                                                         | 10               |
| mcp-server              | client, utils, core, logger, oapi-client, config, atlasd                                      | atlasd                                                                                                                    | 9                |
| evals                   | bundled-agents, client, core, system, oapi-client, agent-sdk, atlasd, utils                   | none                                                                                                                      | 8                |
| web-client              | core, oapi-client, utils, client                                                              | none                                                                                                                      | 4                |
| mcp                     | logger, atlasd                                                                                | core                                                                                                                      | 4                |
| diagnostics             | utils, client, logger, workspace                                                              | none                                                                                                                      | 4                |
| cron                    | logger, workspace                                                                             | atlasd                                                                                                                    | 4                |
| fs-watch                | logger                                                                                        | workspace                                                                                                                 | 3                |
| signals                 | none                                                                                          | atlasd                                                                                                                    | 2                |
| memory_manager          | memory, workspace                                                                             | none                                                                                                                      | 2                |
| openapi-client          | atlasd                                                                                        | none                                                                                                                      | 1                |
| atlas-installer         | none                                                                                          | none                                                                                                                      | 0                |
| schemas                 | none                                                                                          | none                                                                                                                      | 0                |
| typescript-error-report | none                                                                                          | none                                                                                                                      | 0                |
| src                     | none                                                                                          | none                                                                                                                      | 0                |

### Recommended Fix Order

Based on the dependency graph, here's a recommended order for fixing errors:

1. **Start with leaf nodes** (no other packages depend on these):

2. **Then fix middle-tier packages** (1-3 dependents):

3. **Finally, fix core packages** (many packages depend on these):

## Code Quality Hotspots Analysis
