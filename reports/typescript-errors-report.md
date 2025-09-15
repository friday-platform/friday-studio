# TypeScript & Lint Analysis Report

**Generated:** 2025-09-15T04:12:46.705Z

**Total Issues:** 1526 (1202 type errors, 324 deno lint violations, 0 biome
violations)

## Summary Statistics

### TypeScript Errors

- **Total errors:** 1202
- **Unique error types:** 36
- **Files with errors:** 235

### Deno Lint Violations

- **Total violations:** 324
- **Unique rules violated:** 6
- **Files with violations:** 105

### Biome Violations

- **Total violations:** 0
- **Errors:** 0
- **Warnings:** 0
- **Unique rules violated:** 0
- **Files with violations:** 0

## TypeScript Error Types Breakdown

| Error Code | Count | Percentage | Description                                  |
| ---------- | ----- | ---------- | -------------------------------------------- |
| TS18046    | 304   | 25.3%      | Value is of type 'unknown'                   |
| TS2339     | 249   | 20.7%      | Property does not exist on type              |
| TS2322     | 171   | 14.2%      | Type not assignable                          |
| TS6133     | 98    | 8.2%       | Variable declared but never used             |
| TS2345     | 87    | 7.2%       | Argument type not assignable                 |
| TS6196     | 56    | 4.7%       | Catch clause variable unused                 |
| TS7053     | 42    | 3.5%       | Element implicitly has any type              |
| TS2532     | 36    | 3.0%       | Object is possibly 'undefined'               |
| TS18048    | 25    | 2.1%       | Value is possibly 'undefined'                |
| TS2571     | 18    | 1.5%       | Object is of type 'unknown'                  |
| TS2769     | 15    | 1.2%       | No overload matches call                     |
| TS7006     | 10    | 0.8%       | Parameter implicitly has any type            |
| TS2305     | 10    | 0.8%       | Module has no exported member                |
| TS2698     | 10    | 0.8%       | Spread types may only be object types        |
| TS2724     | 9     | 0.7%       | Module has no default export                 |
| TS2694     | 9     | 0.7%       | Namespace has no exported member             |
| TS2349     | 9     | 0.7%       | Cannot invoke expression                     |
| TS2459     | 7     | 0.6%       | TypeScript error                             |
| TS2353     | 5     | 0.4%       | Object literal has unknown properties        |
| TS18047    | 5     | 0.4%       | Value is possibly 'null'                     |
| TS2559     | 4     | 0.3%       | Type has no common properties                |
| TS2741     | 3     | 0.2%       | Property is missing in type                  |
| TS2739     | 2     | 0.2%       | Type is missing properties                   |
| TS2416     | 2     | 0.2%       | Property type not assignable to base         |
| TS2540     | 2     | 0.2%       | Cannot assign to read-only property          |
| TS2367     | 2     | 0.2%       | TypeScript error                             |
| TS2578     | 2     | 0.2%       | Unused ts-expect-error directive             |
| TS4104     | 2     | 0.2%       | Parameter property readonly/mutable conflict |
| TS2638     | 1     | 0.1%       | Cannot augment module                        |
| TS2304     | 1     | 0.1%       | Cannot find name                             |
| TS2820     | 1     | 0.1%       | Type predicate incorrect                     |
| TS6138     | 1     | 0.1%       | Property declared but never used             |
| TS18050    | 1     | 0.1%       | Value is possibly null or undefined          |
| TS2554     | 1     | 0.1%       | Argument count mismatch                      |
| TS2740     | 1     | 0.1%       | Type is missing index signature              |
| TS7017     | 1     | 0.1%       | Type has no index signature                  |

## Deno Lint Rules Breakdown

| Rule Name         | Count | Percentage | Description                      |
| ----------------- | ----- | ---------- | -------------------------------- |
| no-unused-vars    | 131   | 40.4%      | Variable declared but never used |
| require-await     | 109   | 33.6%      | Async function without await     |
| no-process-global | 64    | 19.8%      | Lint rule violation              |
| no-explicit-any   | 11    | 3.4%       | Explicit 'any' type usage        |
| no-empty          | 8     | 2.5%       | Empty block statement            |
| no-control-regex  | 1     | 0.3%       | Control characters in regex      |

## Biome Rules Breakdown

No biome violations found.

## Files with Most Issues

| File                                                      | Type Errors | Deno Lint | Biome | Total |
| --------------------------------------------------------- | ----------- | --------- | ----- | ----- |
| tools/atlas-installer/main.js                             | 0           | 86        | 0     | 86    |
| src/cli/modules/sessions/fetcher.test.ts                  | 57          | 18        | 0     | 75    |
| packages/memory/src/supervisor-memory-coordinator.ts      | 47          | 2         | 0     | 49    |
| packages/memory/src/streaming/memory-stream-processors.ts | 38          | 1         | 0     | 39    |
| apps/web-client/src/lib/modules/client/daemon.ts          | 26          | 3         | 0     | 29    |
| src/utils/version-checker.integration.test.ts             | 28          | 0         | 0     | 28    |
| tests/unit/workspace-add-cli.test.ts                      | 28          | 0         | 0     | 28    |
| src/cli/components/signal-details.tsx                     | 27          | 0         | 0     | 27    |
| packages/memory/src/web-embedding-provider.ts             | 25          | 0         | 0     | 25    |
| src/core/manager.ts                                       | 23          | 1         | 0     | 24    |
| src/cli/utils/daemon-client.ts                            | 22          | 1         | 0     | 23    |
| tests/unit/workspace-add.test.ts                          | 20          | 2         | 0     | 22    |
| packages/mcp-server/src/tools/utils.ts                    | 20          | 1         | 0     | 21    |
| apps/diagnostics/src/paths.ts                             | 10          | 10        | 0     | 20    |
| packages/client/src/client.ts                             | 19          | 0         | 0     | 19    |
| src/utils/paths.ts                                        | 11          | 8         | 0     | 19    |
| apps/atlasd/src/atlas-daemon.ts                           | 18          | 0         | 0     | 18    |
| src/cli/commands/library/stats.tsx                        | 18          | 0         | 0     | 18    |
| tests/unit/cache-sharing-security.test.ts                 | 17          | 1         | 0     | 18    |
| tools/memory_manager/main.ts                              | 17          | 0         | 0     | 17    |
| ... and 234 more files                                    |             |           |       |       |

## Issues by Project

| Project                 | Type Errors | Deno Lint | Biome | Total |
| ----------------------- | ----------- | --------- | ----- | ----- |
| src                     | 459         | 113       | 0     | 572   |
| packages/memory         | 154         | 33        | 0     | 187   |
| tests                   | 113         | 10        | 0     | 123   |
| packages/core           | 75          | 20        | 0     | 95    |
| packages/mcp-server     | 89          | 3         | 0     | 92    |
| tools/atlas-installer   | 0           | 92        | 0     | 92    |
| apps/atlasd             | 56          | 3         | 0     | 59    |
| apps/web-client         | 41          | 5         | 0     | 46    |
| packages/storage        | 39          | 6         | 0     | 45    |
| apps/diagnostics        | 29          | 14        | 0     | 43    |
| tools/memory_manager    | 27          | 11        | 0     | 38    |
| packages/signals        | 23          | 6         | 0     | 29    |
| packages/system         | 24          | 1         | 0     | 25    |
| packages/client         | 22          | 1         | 0     | 23    |
| other                   | 13          | 4         | 0     | 17    |
| packages/cron           | 11          | 0         | 0     | 11    |
| packages/agent-sdk      | 8           | 0         | 0     | 8     |
| packages/notifications  | 8           | 0         | 0     | 8     |
| tools/evals             | 2           | 2         | 0     | 4     |
| packages/mcp            | 3           | 0         | 0     | 3     |
| packages/config         | 2           | 0         | 0     | 2     |
| packages/workspace      | 1           | 0         | 0     | 1     |
| packages/bundled-agents | 1           | 0         | 0     | 1     |
| packages/logger         | 1           | 0         | 0     | 1     |
| packages/openapi-client | 1           | 0         | 0     | 1     |

## Workspace Dependency Graph

### Dependency Analysis

| Package                 | Dependencies                                                                           | Dependents                                                                                                       | Complexity Score |
| ----------------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ---------------- |
| logger                  | utils                                                                                  | atlasd, agent-sdk, core, memory, signals, workspace, mcp, bundled-agents, system, fs-watch, notifications, evals | 25               |
| atlasd                  | config, core, utils, logger, workspace, storage, agent-sdk, cron, mcp-server, memory   | mcp-server, mcp, client, openapi-client, evals                                                                   | 20               |
| core                    | config, logger, mcp, agent-sdk, bundled-agents, oapi-client, memory                    | diagnostics, web-client, atlasd, system, client, evals                                                           | 19               |
| config                  | agent-sdk, storage                                                                     | atlasd, core, workspace, mcp-server, system, notifications                                                       | 14               |
| utils                   | none                                                                                   | diagnostics, atlasd, logger, memory, storage, system, evals                                                      | 14               |
| agent-sdk               | logger                                                                                 | atlasd, core, config, bundled-agents, system, evals                                                              | 13               |
| memory                  | storage, logger, utils                                                                 | atlasd, core, storage, system, memory_manager                                                                    | 13               |
| workspace               | config, logger, storage, system, fs-watch                                              | atlasd, system, cron, memory_manager                                                                             | 13               |
| system                  | logger, config, agent-sdk, bundled-agents, utils, oapi-client, workspace, core, memory | workspace, evals                                                                                                 | 13               |
| storage                 | memory, utils                                                                          | atlasd, memory, config, workspace                                                                                | 10               |
| bundled-agents          | agent-sdk, logger                                                                      | core, system, evals                                                                                              | 8                |
| evals                   | system, agent-sdk, bundled-agents, logger, atlasd, oapi-client, core, utils            | none                                                                                                             | 8                |
| mcp-server              | oapi-client, notifications, config, atlasd                                             | atlasd                                                                                                           | 6                |
| mcp                     | logger, atlasd                                                                         | core                                                                                                             | 4                |
| client                  | atlasd, core                                                                           | diagnostics                                                                                                      | 4                |
| notifications           | config, logger                                                                         | mcp-server                                                                                                       | 4                |
| diagnostics             | client, utils, core                                                                    | none                                                                                                             | 3                |
| fs-watch                | logger                                                                                 | workspace                                                                                                        | 3                |
| cron                    | workspace                                                                              | atlasd                                                                                                           | 3                |
| web-client              | core, oapi-client                                                                      | none                                                                                                             | 2                |
| memory_manager          | memory, workspace                                                                      | none                                                                                                             | 2                |
| signals                 | logger                                                                                 | none                                                                                                             | 1                |
| openapi-client          | atlasd                                                                                 | none                                                                                                             | 1                |
| typescript-error-report | none                                                                                   | none                                                                                                             | 0                |
| src                     | none                                                                                   | none                                                                                                             | 0                |

### Recommended Fix Order

Based on the dependency graph, here's a recommended order for fixing errors:

1. **Start with leaf nodes** (no other packages depend on these):
   - diagnostics (29 errors)
   - web-client (41 errors)
   - signals (23 errors)
   - openapi-client (1 errors)
   - memory_manager (27 errors)
   - evals (2 errors)

2. **Then fix middle-tier packages** (1-3 dependents):
   - mcp-server (89 errors, 1 dependents)
   - mcp (3 errors, 1 dependents)
   - bundled-agents (1 errors, 3 dependents)
   - system (24 errors, 2 dependents)
   - client (22 errors, 1 dependents)
   - notifications (8 errors, 1 dependents)
   - cron (11 errors, 1 dependents)

3. **Finally, fix core packages** (many packages depend on these):
   - atlasd (56 errors, 5 dependents)
   - agent-sdk (8 errors, 6 dependents)
   - core (75 errors, 6 dependents)
   - logger (1 errors, 12 dependents)
   - memory (154 errors, 5 dependents)
   - config (2 errors, 6 dependents)
   - workspace (1 errors, 4 dependents)
   - storage (39 errors, 4 dependents)

## Code Quality Hotspots Analysis

### Most Common Issue Patterns

Issues that appear across multiple files (potential systematic problems):

- **[Type] TS7053**: "Element implicitly has an 'any' type because expre..."
  - Occurrences: 42
  - Files affected: 18

- **[Type] TS18046**: "'data' is of type 'unknown'...."
  - Occurrences: 38
  - Files affected: 5

- **[Type] TS2532**: "Object is possibly 'undefined'...."
  - Occurrences: 36
  - Files affected: 8

- **[Deno Lint] require-await**: "Async arrow function has no 'await' expression
  or ..."
  - Occurrences: 35
  - Files affected: 6

- **[Type] TS2345**: "Argument of type 'unknown' is not assignable to pa..."
  - Occurrences: 26
  - Files affected: 16

- **[Type] TS18046**: "'result' is of type 'unknown'...."
  - Occurrences: 23
  - Files affected: 9

- **[Type] TS18046**: "'memory' is of type 'unknown'...."
  - Occurrences: 19
  - Files affected: 3

- **[Type] TS2571**: "Object is of type 'unknown'...."
  - Occurrences: 18
  - Files affected: 3

- **[Type] TS18046**: "'errorData' is of type 'unknown'...."
  - Occurrences: 17
  - Files affected: 14

- **[Type] TS18046**: "'error' is of type 'unknown'...."
  - Occurrences: 17
  - Files affected: 9

- **[Type] TS2769**: "No overload matches this call...."
  - Occurrences: 15
  - Files affected: 11

- **[Type] TS18046**: "'config' is of type 'unknown'...."
  - Occurrences: 11
  - Files affected: 3

- **[Deno Lint] no-explicit-any**: "`any` type is not allowed..."
  - Occurrences: 11
  - Files affected: 4

- **[Type] TS2322**: "Type 'unknown' is not assignable to type '{ id..."
  - Occurrences: 10
  - Files affected: 4

- **[Type] TS2305**: "Module '"file..."
  - Occurrences: 10
  - Files affected: 7

### High-Impact Files

Files with issues from multiple tools (need attention):

| File                                                      | Type Errors | Deno Lint | Biome | Total |
| --------------------------------------------------------- | ----------- | --------- | ----- | ----- |
| src/cli/modules/sessions/fetcher.test.ts                  | 57          | 18        | 0     | 75    |
| packages/memory/src/supervisor-memory-coordinator.ts      | 47          | 2         | 0     | 49    |
| packages/memory/src/streaming/memory-stream-processors.ts | 38          | 1         | 0     | 39    |
| apps/web-client/src/lib/modules/client/daemon.ts          | 26          | 3         | 0     | 29    |
| src/core/manager.ts                                       | 23          | 1         | 0     | 24    |
| src/cli/utils/daemon-client.ts                            | 22          | 1         | 0     | 23    |
| tests/unit/workspace-add.test.ts                          | 20          | 2         | 0     | 22    |
| packages/mcp-server/src/tools/utils.ts                    | 20          | 1         | 0     | 21    |
| apps/diagnostics/src/paths.ts                             | 10          | 10        | 0     | 20    |
| src/utils/paths.ts                                        | 11          | 8         | 0     | 19    |
