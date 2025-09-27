# TypeScript & Lint Analysis Report

**Generated:** 2025-09-27T03:37:59.007Z

**Total Issues:** 646 (493 type errors, 46 deno lint violations, 107 biome
violations)

## Summary Statistics

### TypeScript Errors

- **Total errors:** 493
- **Unique error types:** 32
- **Files with errors:** 107

### Deno Lint Violations

- **Total violations:** 46
- **Unique rules violated:** 4
- **Files with violations:** 18

### Biome Violations

- **Total violations:** 107
- **Errors:** 1
- **Warnings:** 106
- **Unique rules violated:** 21
- **Files with violations:** 53

## TypeScript Error Types Breakdown

| Error Code | Count | Percentage | Description                                  |
| ---------- | ----- | ---------- | -------------------------------------------- |
| TS2339     | 98    | 19.9%      | Property does not exist on type              |
| TS18046    | 94    | 19.1%      | Value is of type 'unknown'                   |
| TS2322     | 84    | 17.0%      | Type not assignable                          |
| TS18048    | 69    | 14.0%      | Value is possibly 'undefined'                |
| TS2345     | 49    | 9.9%       | Argument type not assignable                 |
| TS6133     | 15    | 3.0%       | Variable declared but never used             |
| TS2532     | 14    | 2.8%       | Object is possibly 'undefined'               |
| TS2305     | 7     | 1.4%       | Module has no exported member                |
| TS6196     | 7     | 1.4%       | Catch clause variable unused                 |
| TS7053     | 7     | 1.4%       | Element implicitly has any type              |
| TS2571     | 6     | 1.2%       | Object is of type 'unknown'                  |
| TS2531     | 6     | 1.2%       | Object is possibly 'null'                    |
| TS2694     | 6     | 1.2%       | Namespace has no exported member             |
| TS7006     | 4     | 0.8%       | Parameter implicitly has any type            |
| TS2698     | 4     | 0.8%       | Spread types may only be object types        |
| TS2769     | 2     | 0.4%       | No overload matches call                     |
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
| require-await   | 28    | 60.9%      | Async function without await     |
| no-unused-vars  | 13    | 28.3%      | Variable declared but never used |
| no-explicit-any | 3     | 6.5%       | Explicit 'any' type usage        |
| no-empty        | 2     | 4.3%       | Empty block statement            |

## Biome Rules Breakdown

| Rule Name                               | Count | Percentage | Severity Distribution |
| --------------------------------------- | ----- | ---------- | --------------------- |
| correctness/useExhaustiveDependencies   | 23    | 21.5%      | 1E/22W                |
| style/useTemplate                       | 21    | 19.6%      | 21W                   |
| correctness/noUnusedVariables           | 18    | 16.8%      | 18W                   |
| complexity/noStaticOnlyClass            | 7     | 6.5%       | 7W                    |
| suspicious/noArrayIndexKey              | 7     | 6.5%       | 7W                    |
| complexity/useOptionalChain             | 6     | 5.6%       | 6W                    |
| complexity/useLiteralKeys               | 3     | 2.8%       | 3W                    |
| correctness/noUnusedPrivateClassMembers | 3     | 2.8%       | 3W                    |
| suspicious/noExplicitAny                | 3     | 2.8%       | 3W                    |
| correctness/useParseIntRadix            | 2     | 1.9%       | 2W                    |
| suspicious/noEmptyBlock                 | 2     | 1.9%       | 2W                    |
| correctness/noUnusedFunctionParameters  | 2     | 1.9%       | 2W                    |
| suspicious/noAssignInExpressions        | 2     | 1.9%       | 2W                    |
| complexity/noUselessFragments           | 1     | 0.9%       | 1W                    |
| complexity/noUselessSwitchCase          | 1     | 0.9%       | 1W                    |
| suspicious/noConfusingVoidType          | 1     | 0.9%       | 1W                    |
| suspicious/noIrregularWhitespace        | 1     | 0.9%       | 1W                    |
| complexity/noImportantStyles            | 1     | 0.9%       | 1W                    |
| suspicious/useIterableCallbackReturn    | 1     | 0.9%       | 1W                    |
| suspicious/noImplicitAnyLet             | 1     | 0.9%       | 1W                    |
| correctness/useHookAtTopLevel           | 1     | 0.9%       | 1W                    |

## Files with Most Issues

| File                                                           | Type Errors | Deno Lint | Biome | Total |
| -------------------------------------------------------------- | ----------- | --------- | ----- | ----- |
| src/cli/utils/prompts.tsx                                      | 5           | 11        | 8     | 24    |
| packages/client/src/client.ts                                  | 23          | 0         | 0     | 23    |
| apps/atlasd/routes/streams/emit.ts                             | 21          | 0         | 0     | 21    |
| packages/cron/tests/timer-signal-workspace-integration.test.ts | 19          | 0         | 2     | 21    |
| packages/mcp-server/src/tools/utils.ts                         | 17          | 2         | 0     | 19    |
| src/cli/commands/library/stats.tsx                             | 18          | 0         | 1     | 19    |
| src/cli/utils/conversation-client.ts                           | 12          | 3         | 3     | 18    |
| src/cli/utils/daemon-client.ts                                 | 18          | 0         | 0     | 18    |
| apps/atlasd/routes/workspaces/index.ts                         | 16          | 0         | 0     | 16    |
| packages/storage/src/vector/vector-search-local.ts             | 14          | 0         | 1     | 15    |
| src/cli/modules/messages/message-buffer.tsx                    | 11          | 0         | 4     | 15    |
| src/cli/commands/library/list.tsx                              | 12          | 0         | 0     | 12    |
| packages/cron/tests/timer-signal-storage-persistence.test.ts   | 11          | 0         | 0     | 11    |
| src/cli/commands/workspace/add.tsx                             | 0           | 0         | 11    | 11    |
| packages/cron/src/cron-manager.ts                              | 10          | 0         | 0     | 10    |
| packages/signals/src/providers/k8s-auth.ts                     | 5           | 1         | 4     | 10    |
| src/core/storage/memory-kv-storage.ts                          | 2           | 8         | 0     | 10    |
| packages/cron/tests/timer-signal-error-recovery.test.ts        | 10          | 0         | 0     | 10    |
| packages/core/src/orchestrator/agent-orchestrator.ts           | 9           | 0         | 0     | 9     |
| packages/signals/src/providers/http-webhook.ts                 | 5           | 4         | 0     | 9     |
| ... and 118 more files                                         |             |           |       |       |

## Issues by Project

| Project                 | Type Errors | Deno Lint | Biome | Total |
| ----------------------- | ----------- | --------- | ----- | ----- |
| src                     | 167         | 29        | 72    | 268   |
| apps/atlasd             | 64          | 0         | 2     | 66    |
| packages/core           | 55          | 3         | 6     | 64    |
| packages/cron           | 52          | 0         | 2     | 54    |
| packages/mcp-server     | 35          | 2         | 0     | 37    |
| packages/signals        | 23          | 6         | 7     | 36    |
| packages/client         | 26          | 0         | 0     | 26    |
| packages/storage        | 20          | 5         | 1     | 26    |
| apps/web-client         | 15          | 0         | 2     | 17    |
| other                   | 9           | 0         | 2     | 11    |
| packages/notifications  | 9           | 0         | 0     | 9     |
| packages/system         | 8           | 0         | 0     | 8     |
| tools/atlas-installer   | 0           | 0         | 8     | 8     |
| packages/mcp            | 4           | 0         | 1     | 5     |
| packages/openapi-client | 1           | 0         | 2     | 3     |
| packages/memory         | 0           | 1         | 2     | 3     |
| packages/agent-sdk      | 2           | 0         | 0     | 2     |
| tools/evals             | 2           | 0         | 0     | 2     |
| packages/workspace      | 1           | 0         | 0     | 1     |

## Workspace Dependency Graph

### Dependency Analysis

| Package                 | Dependencies                                                                  | Dependents                                                                                                                                | Complexity Score |
| ----------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| logger                  | utils                                                                         | diagnostics, atlasd, agent-sdk, core, memory, signals, workspace, mcp-server, mcp, bundled-agents, system, fs-watch, notifications, evals | 29               |
| utils                   | none                                                                          | diagnostics, atlasd, core, logger, memory, config, mcp-server, bundled-agents, storage, system, client, evals                             | 24               |
| core                    | config, logger, mcp, utils, agent-sdk, bundled-agents, oapi-client, memory    | web-client, atlasd, agent-sdk, mcp-server, client, evals                                                                                  | 20               |
| atlasd                  | core, logger, utils, config, workspace, storage, cron, mcp-server, memory     | mcp-server, mcp, client, openapi-client, evals                                                                                            | 19               |
| config                  | utils, agent-sdk, storage                                                     | atlasd, core, workspace, mcp-server, system, notifications                                                                                | 15               |
| memory                  | storage, logger, utils                                                        | atlasd, core, storage, system, memory_manager                                                                                             | 13               |
| workspace               | config, logger, storage, system, fs-watch                                     | diagnostics, atlasd, cron, memory_manager                                                                                                 | 13               |
| agent-sdk               | logger, core                                                                  | core, config, bundled-agents, system, evals                                                                                               | 12               |
| system                  | logger, config, agent-sdk, bundled-agents, utils, oapi-client, memory, client | workspace, evals                                                                                                                          | 12               |
| client                  | utils, atlasd, core                                                           | diagnostics, web-client, mcp-server, system                                                                                               | 11               |
| mcp-server              | client, utils, core, oapi-client, logger, notifications, config, atlasd       | atlasd                                                                                                                                    | 10               |
| storage                 | memory, utils                                                                 | atlasd, memory, config, workspace                                                                                                         | 10               |
| bundled-agents          | agent-sdk, logger, utils                                                      | core, system, evals                                                                                                                       | 9                |
| evals                   | bundled-agents, system, oapi-client, agent-sdk, logger, atlasd, core, utils   | none                                                                                                                                      | 8                |
| diagnostics             | utils, client, logger, workspace                                              | none                                                                                                                                      | 4                |
| mcp                     | logger, atlasd                                                                | core                                                                                                                                      | 4                |
| notifications           | config, logger                                                                | mcp-server                                                                                                                                | 4                |
| web-client              | client, core, oapi-client                                                     | none                                                                                                                                      | 3                |
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
   - evals (2 errors)

2. **Then fix middle-tier packages** (1-3 dependents):
   - mcp-server (35 errors, 1 dependents)
   - mcp (4 errors, 1 dependents)
   - system (8 errors, 2 dependents)
   - notifications (9 errors, 1 dependents)
   - cron (52 errors, 1 dependents)

3. **Finally, fix core packages** (many packages depend on these):
   - atlasd (64 errors, 5 dependents)
   - agent-sdk (2 errors, 5 dependents)
   - core (55 errors, 6 dependents)
   - workspace (1 errors, 4 dependents)
   - storage (20 errors, 4 dependents)
   - client (26 errors, 4 dependents)

## Code Quality Hotspots Analysis

### Most Common Issue Patterns

Issues that appear across multiple files (potential systematic problems):

- **[Biome] style/useTemplate**: "Template literals are preferred over string
  concat..."
  - Occurrences: 21
  - Files affected: 15

- **[Type] TS18048**: "'timer' is possibly 'undefined'...."
  - Occurrences: 19
  - Files affected: 3

- **[Biome] correctness/noUnusedVariables**: "Unused variables are often the
  result of an incomp..."
  - Occurrences: 18
  - Files affected: 8

- **[Type] TS2345**: "Argument of type 'string | undefined' is not assig..."
  - Occurrences: 14
  - Files affected: 8

- **[Type] TS2532**: "Object is possibly 'undefined'...."
  - Occurrences: 14
  - Files affected: 4

- **[Type] TS18046**: "'errorData' is of type 'unknown'...."
  - Occurrences: 11
  - Files affected: 8

- **[Type] TS2345**: "Argument of type 'unknown' is not assignable to pa..."
  - Occurrences: 8
  - Files affected: 6

- **[Type] TS2305**: "Module '"file..."
  - Occurrences: 7
  - Files affected: 4

- **[Type] TS7053**: "Element implicitly has an 'any' type because expre..."
  - Occurrences: 7
  - Files affected: 5

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

- **[Type] TS2322**: "Type 'unknown' is not assignable to type 'Record<s..."
  - Occurrences: 5
  - Files affected: 4

- **[Type] TS2698**: "Spread types may only be created from object types..."
  - Occurrences: 4
  - Files affected: 4

- **[Biome] correctness/useExhaustiveDependencies**: "This hook specifies more
  dependencies than necessa..."
  - Occurrences: 4
  - Files affected: 3

### High-Impact Files

Files with issues from multiple tools (need attention):

| File                                                           | Type Errors | Deno Lint | Biome | Total |
| -------------------------------------------------------------- | ----------- | --------- | ----- | ----- |
| src/cli/utils/prompts.tsx                                      | 5           | 11        | 8     | 24    |
| packages/cron/tests/timer-signal-workspace-integration.test.ts | 19          | 0         | 2     | 21    |
| packages/mcp-server/src/tools/utils.ts                         | 17          | 2         | 0     | 19    |
| src/cli/commands/library/stats.tsx                             | 18          | 0         | 1     | 19    |
| src/cli/utils/conversation-client.ts                           | 12          | 3         | 3     | 18    |
| packages/storage/src/vector/vector-search-local.ts             | 14          | 0         | 1     | 15    |
| src/cli/modules/messages/message-buffer.tsx                    | 11          | 0         | 4     | 15    |
| packages/signals/src/providers/k8s-auth.ts                     | 5           | 1         | 4     | 10    |
| src/core/storage/memory-kv-storage.ts                          | 2           | 8         | 0     | 10    |
| packages/signals/src/providers/http-webhook.ts                 | 5           | 4         | 0     | 9     |
