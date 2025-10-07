# TypeScript & Lint Analysis Report

**Generated:** 2025-10-07T04:13:04.328Z

**Total Issues:** 4 (0 type errors, 0 deno lint violations, 4 biome violations)

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

- **Total violations:** 4
- **Errors:** 0
- **Warnings:** 4
- **Unique rules violated:** 3
- **Files with violations:** 3

## TypeScript Error Types Breakdown

No TypeScript errors found.

## Deno Lint Rules Breakdown

No lint violations found.

## Biome Rules Breakdown

| Rule Name                        | Count | Percentage | Severity Distribution |
| -------------------------------- | ----- | ---------- | --------------------- |
| suspicious/noEmptyBlock          | 2     | 50.0%      | 2W                    |
| suspicious/noIrregularWhitespace | 1     | 25.0%      | 1W                    |
| complexity/noImportantStyles     | 1     | 25.0%      | 1W                    |

## Files with Most Issues

| File                             | Type Errors | Deno Lint | Biome | Total |
| -------------------------------- | ----------- | --------- | ----- | ----- |
| tools/atlas-installer/styles.css | 0           | 0         | 2     | 2     |
| apps/web-client/src/reset.css    | 0           | 0         | 1     | 1     |
| tools/atlas-installer/reset.css  | 0           | 0         | 1     | 1     |

## Issues by Project

| Project               | Type Errors | Deno Lint | Biome | Total |
| --------------------- | ----------- | --------- | ----- | ----- |
| tools/atlas-installer | 0           | 0         | 3     | 3     |
| apps/web-client       | 0           | 0         | 1     | 1     |

## Workspace Dependency Graph

### Dependency Analysis

| Package                 | Dependencies                                                                                  | Dependents                                                                                                                         | Complexity Score |
| ----------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| utils                   | none                                                                                          | web-client, atlasd, core, logger, memory, config, signals, mcp-server, bundled-agents, storage, system, diagnostics, client, evals | 28               |
| core                    | config, logger, mcp, utils, agent-sdk, bundled-agents, oapi-client, client, memory            | web-client, atlasd, agent-sdk, mcp-server, bundled-agents, system, client, evals                                                   | 25               |
| logger                  | utils                                                                                         | atlasd, agent-sdk, core, memory, signals, workspace, mcp, bundled-agents, system, fs-watch, diagnostics, notifications             | 25               |
| atlasd                  | core, logger, utils, config, storage, agent-sdk, cron, mcp-server, memory, workspace, signals | mcp-server, mcp, client, openapi-client, evals                                                                                     | 21               |
| client                  | utils, atlasd, core, oapi-client                                                              | web-client, core, mcp-server, system, diagnostics, evals                                                                           | 16               |
| agent-sdk               | logger, core                                                                                  | atlasd, core, config, bundled-agents, system, evals                                                                                | 14               |
| memory                  | storage, logger, utils                                                                        | atlasd, core, storage, system, memory_manager                                                                                      | 13               |
| config                  | utils, agent-sdk, storage                                                                     | atlasd, core, workspace, system, notifications                                                                                     | 13               |
| workspace               | config, logger, storage, system, fs-watch                                                     | atlasd, diagnostics, cron, memory_manager                                                                                          | 13               |
| system                  | agent-sdk, client, core, utils, config, bundled-agents, logger, memory, oapi-client           | workspace, evals                                                                                                                   | 13               |
| bundled-agents          | agent-sdk, core, logger, utils                                                                | core, system, evals                                                                                                                | 10               |
| storage                 | memory, utils                                                                                 | atlasd, memory, config, workspace                                                                                                  | 10               |
| mcp-server              | client, utils, core, oapi-client, notifications, atlasd                                       | atlasd                                                                                                                             | 8                |
| evals                   | bundled-agents, client, core, system, oapi-client, agent-sdk, atlasd, utils                   | none                                                                                                                               | 8                |
| web-client              | core, oapi-client, utils, client                                                              | none                                                                                                                               | 4                |
| signals                 | logger, utils                                                                                 | atlasd                                                                                                                             | 4                |
| mcp                     | logger, atlasd                                                                                | core                                                                                                                               | 4                |
| diagnostics             | utils, client, logger, workspace                                                              | none                                                                                                                               | 4                |
| notifications           | config, logger                                                                                | mcp-server                                                                                                                         | 4                |
| fs-watch                | logger                                                                                        | workspace                                                                                                                          | 3                |
| cron                    | workspace                                                                                     | atlasd                                                                                                                             | 3                |
| memory_manager          | memory, workspace                                                                             | none                                                                                                                               | 2                |
| openapi-client          | atlasd                                                                                        | none                                                                                                                               | 1                |
| typescript-error-report | none                                                                                          | none                                                                                                                               | 0                |
| src                     | none                                                                                          | none                                                                                                                               | 0                |

### Recommended Fix Order

Based on the dependency graph, here's a recommended order for fixing errors:

1. **Start with leaf nodes** (no other packages depend on these):

2. **Then fix middle-tier packages** (1-3 dependents):

3. **Finally, fix core packages** (many packages depend on these):

## Code Quality Hotspots Analysis
