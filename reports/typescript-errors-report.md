# TypeScript & Lint Analysis Report

**Generated:** 2025-09-25T22:23:37.009Z

**Total Issues:** 787 (557 type errors, 87 deno lint violations, 143 biome
violations)

## Summary Statistics

### TypeScript Errors

- **Total errors:** 557
- **Unique error types:** 32
- **Files with errors:** 115

### Deno Lint Violations

- **Total violations:** 87
- **Unique rules violated:** 4
- **Files with violations:** 30

### Biome Violations

- **Total violations:** 143
- **Errors:** 2
- **Warnings:** 141
- **Unique rules violated:** 22
- **Files with violations:** 59

## TypeScript Error Types Breakdown

| Error Code | Count | Percentage | Description                                  |
| ---------- | ----- | ---------- | -------------------------------------------- |
| TS2339     | 117   | 21.0%      | Property does not exist on type              |
| TS2322     | 96    | 17.2%      | Type not assignable                          |
| TS18046    | 96    | 17.2%      | Value is of type 'unknown'                   |
| TS18048    | 75    | 13.5%      | Value is possibly 'undefined'                |
| TS2345     | 56    | 10.1%      | Argument type not assignable                 |
| TS6133     | 17    | 3.1%       | Variable declared but never used             |
| TS2532     | 16    | 2.9%       | Object is possibly 'undefined'               |
| TS7053     | 14    | 2.5%       | Element implicitly has any type              |
| TS6196     | 9     | 1.6%       | Catch clause variable unused                 |
| TS7006     | 7     | 1.3%       | Parameter implicitly has any type            |
| TS2694     | 7     | 1.3%       | Namespace has no exported member             |
| TS2305     | 6     | 1.1%       | Module has no exported member                |
| TS2571     | 6     | 1.1%       | Object is of type 'unknown'                  |
| TS2531     | 6     | 1.1%       | Object is possibly 'null'                    |
| TS2769     | 4     | 0.7%       | No overload matches call                     |
| TS2698     | 4     | 0.7%       | Spread types may only be object types        |
| TS2739     | 2     | 0.4%       | Type is missing properties                   |
| TS2416     | 2     | 0.4%       | Property type not assignable to base         |
| TS2578     | 2     | 0.4%       | Unused ts-expect-error directive             |
| TS4104     | 2     | 0.4%       | Parameter property readonly/mutable conflict |
| TS18047    | 2     | 0.4%       | Value is possibly 'null'                     |
| TS2353     | 1     | 0.2%       | Object literal has unknown properties        |
| TS2741     | 1     | 0.2%       | Property is missing in type                  |
| TS2554     | 1     | 0.2%       | Argument count mismatch                      |
| TS2538     | 1     | 0.2%       | TypeScript error                             |
| TS2540     | 1     | 0.2%       | Cannot assign to read-only property          |
| TS6138     | 1     | 0.2%       | Property declared but never used             |
| TS2724     | 1     | 0.2%       | Module has no default export                 |
| TS2559     | 1     | 0.2%       | Type has no common properties                |
| TS2740     | 1     | 0.2%       | Type is missing index signature              |
| TS18004    | 1     | 0.2%       | TypeScript error                             |
| TS7017     | 1     | 0.2%       | Type has no index signature                  |

## Deno Lint Rules Breakdown

| Rule Name       | Count | Percentage | Description                      |
| --------------- | ----- | ---------- | -------------------------------- |
| require-await   | 66    | 75.9%      | Async function without await     |
| no-unused-vars  | 15    | 17.2%      | Variable declared but never used |
| no-explicit-any | 4     | 4.6%       | Explicit 'any' type usage        |
| no-empty        | 2     | 2.3%       | Empty block statement            |

## Biome Rules Breakdown

| Rule Name                               | Count | Percentage | Severity Distribution |
| --------------------------------------- | ----- | ---------- | --------------------- |
| style/useTemplate                       | 48    | 33.6%      | 48W                   |
| correctness/useExhaustiveDependencies   | 23    | 16.1%      | 1E/22W                |
| correctness/noUnusedVariables           | 21    | 14.7%      | 21W                   |
| complexity/noStaticOnlyClass            | 7     | 4.9%       | 7W                    |
| suspicious/noArrayIndexKey              | 7     | 4.9%       | 7W                    |
| complexity/useOptionalChain             | 6     | 4.2%       | 6W                    |
| complexity/useLiteralKeys               | 5     | 3.5%       | 5W                    |
| suspicious/noExplicitAny                | 4     | 2.8%       | 4W                    |
| correctness/useParseIntRadix            | 3     | 2.1%       | 3W                    |
| correctness/noUnusedPrivateClassMembers | 3     | 2.1%       | 3W                    |
| suspicious/noEmptyBlock                 | 2     | 1.4%       | 2W                    |
| correctness/noUnusedFunctionParameters  | 2     | 1.4%       | 2W                    |
| suspicious/noImplicitAnyLet             | 2     | 1.4%       | 2W                    |
| suspicious/noAssignInExpressions        | 2     | 1.4%       | 2W                    |
| complexity/noUselessFragments           | 1     | 0.7%       | 1W                    |
| complexity/noUselessSwitchCase          | 1     | 0.7%       | 1W                    |
| suspicious/noConfusingVoidType          | 1     | 0.7%       | 1W                    |
| correctness/noUnusedImports             | 1     | 0.7%       | 1W                    |
| suspicious/noIrregularWhitespace        | 1     | 0.7%       | 1W                    |
| complexity/noImportantStyles            | 1     | 0.7%       | 1E                    |
| suspicious/useIterableCallbackReturn    | 1     | 0.7%       | 1W                    |
| correctness/useHookAtTopLevel           | 1     | 0.7%       | 1W                    |

## Files with Most Issues

| File                                                           | Type Errors | Deno Lint | Biome | Total |
| -------------------------------------------------------------- | ----------- | --------- | ----- | ----- |
| tools/memory_manager/src/tui.ts                                | 8           | 9         | 26    | 43    |
| src/cli/utils/daemon-client.ts                                 | 22          | 1         | 1     | 24    |
| src/cli/utils/prompts.tsx                                      | 5           | 11        | 8     | 24    |
| packages/client/src/client.ts                                  | 23          | 0         | 0     | 23    |
| apps/atlasd/routes/streams/emit.ts                             | 21          | 0         | 0     | 21    |
| packages/cron/tests/timer-signal-workspace-integration.test.ts | 19          | 0         | 2     | 21    |
| packages/mcp-server/src/tools/utils.ts                         | 17          | 2         | 0     | 19    |
| src/cli/commands/library/stats.tsx                             | 18          | 0         | 1     | 19    |
| apps/atlasd/src/atlas-daemon.ts                                | 18          | 0         | 0     | 18    |
| src/cli/utils/conversation-client.ts                           | 12          | 3         | 3     | 18    |
| src/core/actors/session-supervisor-actor.ts                    | 12          | 0         | 6     | 18    |
| tools/memory_manager/main.ts                                   | 17          | 0         | 1     | 18    |
| packages/storage/src/vector/vector-search-local.ts             | 14          | 0         | 1     | 15    |
| src/cli/modules/messages/message-buffer.tsx                    | 11          | 0         | 4     | 15    |
| packages/cron/tests/timer-signal-storage-persistence.test.ts   | 11          | 0         | 0     | 11    |
| packages/memory/tests/coala-memory-working.test.ts             | 0           | 11        | 0     | 11    |
| src/cli/commands/workspace/add.tsx                             | 0           | 0         | 11    | 11    |
| packages/core/src/agent-context/index.ts                       | 9           | 1         | 0     | 10    |
| packages/cron/src/cron-manager.ts                              | 10          | 0         | 0     | 10    |
| packages/signals/src/providers/k8s-auth.ts                     | 5           | 1         | 4     | 10    |
| ... and 133 more files                                         |             |           |       |       |

## Issues by Project

| Project                 | Type Errors | Deno Lint | Biome | Total |
| ----------------------- | ----------- | --------- | ----- | ----- |
| src                     | 183         | 32        | 81    | 296   |
| packages/core           | 62          | 3         | 6     | 71    |
| apps/atlasd             | 64          | 0         | 2     | 66    |
| tools/memory_manager    | 25          | 9         | 27    | 61    |
| packages/cron           | 52          | 0         | 2     | 54    |
| packages/mcp-server     | 35          | 2         | 0     | 37    |
| packages/storage        | 30          | 6         | 1     | 37    |
| packages/signals        | 23          | 6         | 7     | 36    |
| packages/memory         | 4           | 29        | 2     | 35    |
| packages/client         | 23          | 0         | 0     | 23    |
| apps/web-client         | 15          | 0         | 1     | 16    |
| packages/system         | 13          | 0         | 1     | 14    |
| other                   | 9           | 0         | 2     | 11    |
| packages/notifications  | 9           | 0         | 0     | 9     |
| tools/atlas-installer   | 0           | 0         | 8     | 8     |
| packages/mcp            | 4           | 0         | 1     | 5     |
| packages/openapi-client | 1           | 0         | 2     | 3     |
| packages/agent-sdk      | 2           | 0         | 0     | 2     |
| tools/evals             | 2           | 0         | 0     | 2     |
| packages/workspace      | 1           | 0         | 0     | 1     |

## Workspace Dependency Graph

### Dependency Analysis

| Package                 | Dependencies                                                                  | Dependents                                                                                                                                | Complexity Score |
| ----------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| logger                  | utils                                                                         | diagnostics, atlasd, agent-sdk, core, memory, signals, workspace, mcp-server, mcp, bundled-agents, system, fs-watch, notifications, evals | 29               |
| utils                   | none                                                                          | diagnostics, atlasd, core, logger, memory, config, mcp-server, bundled-agents, storage, system, client, evals                             | 24               |
| atlasd                  | core, logger, utils, config, workspace, storage, cron, mcp-server, memory     | mcp-server, mcp, client, openapi-client, evals                                                                                            | 19               |
| core                    | config, logger, mcp, utils, agent-sdk, bundled-agents, oapi-client, memory    | web-client, atlasd, mcp-server, client, evals                                                                                             | 18               |
| config                  | utils, agent-sdk, storage                                                     | atlasd, core, workspace, mcp-server, system, notifications                                                                                | 15               |
| memory                  | storage, logger, utils                                                        | atlasd, core, storage, system, memory_manager                                                                                             | 13               |
| workspace               | config, logger, storage, system, fs-watch                                     | diagnostics, atlasd, cron, memory_manager                                                                                                 | 13               |
| system                  | logger, config, agent-sdk, bundled-agents, utils, oapi-client, memory, client | workspace, evals                                                                                                                          | 12               |
| agent-sdk               | logger                                                                        | core, config, bundled-agents, system, evals                                                                                               | 11               |
| client                  | atlasd, utils, core                                                           | diagnostics, web-client, mcp-server, system                                                                                               | 11               |
| mcp-server              | client, utils, core, oapi-client, logger, notifications, config, atlasd       | atlasd                                                                                                                                    | 10               |
| storage                 | memory, utils                                                                 | atlasd, memory, config, workspace                                                                                                         | 10               |
| bundled-agents          | agent-sdk, logger, utils                                                      | core, system, evals                                                                                                                       | 9                |
| evals                   | bundled-agents, system, oapi-client, agent-sdk, logger, atlasd, core, utils   | none                                                                                                                                      | 8                |
| diagnostics             | utils, client, logger, workspace                                              | none                                                                                                                                      | 4                |
| mcp                     | logger, atlasd                                                                | core                                                                                                                                      | 4                |
| notifications           | config, logger                                                                | mcp-server                                                                                                                                | 4                |
| web-client              | core, oapi-client, client                                                     | none                                                                                                                                      | 3                |
| fs-watch                | logger                                                                        | workspace                                                                                                                                 | 3                |
| cron                    | workspace                                                                     | atlasd                                                                                                                                    | 3                |
| memory_manager          | memory, workspace                                                             | none                                                                                                                                      | 2                |
| signals                 | logger                                                                        | none                                                                                                                                      | 1                |
| openapi-client          | atlasd                                                                        | none                                                                                                                                      | 1                |
| typescript-error-report | none                                                                          | none                                                                                                                                      | 0                |
| src                     | none                                                                          | none                                                                                                                                      | 0                |

### Recommended Fix Order

Based on the dependency graph, here's a recommended order for fixing errors:

1. **Start with leaf nodes** (no other packages depend on these):
   - web-client (15 errors)
   - signals (23 errors)
   - openapi-client (1 errors)
   - memory_manager (25 errors)
   - evals (2 errors)

2. **Then fix middle-tier packages** (1-3 dependents):
   - mcp-server (35 errors, 1 dependents)
   - mcp (4 errors, 1 dependents)
   - system (13 errors, 2 dependents)
   - notifications (9 errors, 1 dependents)
   - cron (52 errors, 1 dependents)

3. **Finally, fix core packages** (many packages depend on these):
   - atlasd (64 errors, 5 dependents)
   - agent-sdk (2 errors, 5 dependents)
   - core (62 errors, 5 dependents)
   - memory (4 errors, 5 dependents)
   - workspace (1 errors, 4 dependents)
   - storage (30 errors, 4 dependents)
   - client (23 errors, 4 dependents)

## Code Quality Hotspots Analysis

### Most Common Issue Patterns

Issues that appear across multiple files (potential systematic problems):

- **[Biome] style/useTemplate**: "Template literals are preferred over string
  concat..."
  - Occurrences: 48
  - Files affected: 18

- **[Biome] correctness/noUnusedVariables**: "Unused variables are often the
  result of an incomp..."
  - Occurrences: 21
  - Files affected: 11

- **[Type] TS18048**: "'timer' is possibly 'undefined'...."
  - Occurrences: 19
  - Files affected: 3

- **[Type] TS2532**: "Object is possibly 'undefined'...."
  - Occurrences: 16
  - Files affected: 6

- **[Type] TS2345**: "Argument of type 'string | undefined' is not assig..."
  - Occurrences: 14
  - Files affected: 8

- **[Type] TS7053**: "Element implicitly has an 'any' type because expre..."
  - Occurrences: 14
  - Files affected: 8

- **[Type] TS18046**: "'errorData' is of type 'unknown'...."
  - Occurrences: 11
  - Files affected: 8

- **[Type] TS2345**: "Argument of type 'unknown' is not assignable to pa..."
  - Occurrences: 9
  - Files affected: 6

- **[Biome] complexity/noStaticOnlyClass**: "Prefer using simple functions
  instead of classes w..."
  - Occurrences: 7
  - Files affected: 6

- **[Biome] suspicious/noArrayIndexKey**: "Avoid using the index of an array as
  key property ..."
  - Occurrences: 7
  - Files affected: 4

- **[Type] TS2322**: "Type 'unknown' is not assignable to type '{ id..."
  - Occurrences: 6
  - Files affected: 3

- **[Type] TS2305**: "Module '"file..."
  - Occurrences: 6
  - Files affected: 5

- **[Type] TS2322**: "Type 'unknown' is not assignable to type 'Record<s..."
  - Occurrences: 6
  - Files affected: 5

- **[Biome] complexity/useLiteralKeys**: "The computed expression can be
  simplified without ..."
  - Occurrences: 5
  - Files affected: 4

- **[Type] TS2769**: "No overload matches this call...."
  - Occurrences: 4
  - Files affected: 4

### High-Impact Files

Files with issues from multiple tools (need attention):

| File                                                           | Type Errors | Deno Lint | Biome | Total |
| -------------------------------------------------------------- | ----------- | --------- | ----- | ----- |
| tools/memory_manager/src/tui.ts                                | 8           | 9         | 26    | 43    |
| src/cli/utils/daemon-client.ts                                 | 22          | 1         | 1     | 24    |
| src/cli/utils/prompts.tsx                                      | 5           | 11        | 8     | 24    |
| packages/cron/tests/timer-signal-workspace-integration.test.ts | 19          | 0         | 2     | 21    |
| packages/mcp-server/src/tools/utils.ts                         | 17          | 2         | 0     | 19    |
| src/cli/commands/library/stats.tsx                             | 18          | 0         | 1     | 19    |
| src/cli/utils/conversation-client.ts                           | 12          | 3         | 3     | 18    |
| src/core/actors/session-supervisor-actor.ts                    | 12          | 0         | 6     | 18    |
| tools/memory_manager/main.ts                                   | 17          | 0         | 1     | 18    |
| packages/storage/src/vector/vector-search-local.ts             | 14          | 0         | 1     | 15    |
