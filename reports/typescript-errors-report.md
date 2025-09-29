# TypeScript & Lint Analysis Report

**Generated:** 2025-09-29T13:53:41.361Z

**Total Issues:** 558 (410 type errors, 43 deno lint violations, 105 biome
violations)

## Summary Statistics

### TypeScript Errors

- **Total errors:** 410
- **Unique error types:** 31
- **Files with errors:** 93

### Deno Lint Violations

- **Total violations:** 43
- **Unique rules violated:** 3
- **Files with violations:** 16

### Biome Violations

- **Total violations:** 105
- **Errors:** 2
- **Warnings:** 103
- **Unique rules violated:** 21
- **Files with violations:** 52

## TypeScript Error Types Breakdown

| Error Code | Count | Percentage | Description                                  |
| ---------- | ----- | ---------- | -------------------------------------------- |
| TS2339     | 89    | 21.7%      | Property does not exist on type              |
| TS2322     | 84    | 20.5%      | Type not assignable                          |
| TS18046    | 65    | 15.9%      | Value is of type 'unknown'                   |
| TS2345     | 50    | 12.2%      | Argument type not assignable                 |
| TS18048    | 23    | 5.6%       | Value is possibly 'undefined'                |
| TS6133     | 15    | 3.7%       | Variable declared but never used             |
| TS2532     | 14    | 3.4%       | Object is possibly 'undefined'               |
| TS6196     | 7     | 1.7%       | Catch clause variable unused                 |
| TS7006     | 6     | 1.5%       | Parameter implicitly has any type            |
| TS2571     | 6     | 1.5%       | Object is of type 'unknown'                  |
| TS7053     | 6     | 1.5%       | Element implicitly has any type              |
| TS2531     | 6     | 1.5%       | Object is possibly 'null'                    |
| TS2694     | 6     | 1.5%       | Namespace has no exported member             |
| TS2305     | 5     | 1.2%       | Module has no exported member                |
| TS2554     | 3     | 0.7%       | Argument count mismatch                      |
| TS6236     | 3     | 0.7%       | TypeScript error                             |
| TS2769     | 2     | 0.5%       | No overload matches call                     |
| TS2739     | 2     | 0.5%       | Type is missing properties                   |
| TS2416     | 2     | 0.5%       | Property type not assignable to base         |
| TS2698     | 2     | 0.5%       | Spread types may only be object types        |
| TS2578     | 2     | 0.5%       | Unused ts-expect-error directive             |
| TS4104     | 2     | 0.5%       | Parameter property readonly/mutable conflict |
| TS18047    | 2     | 0.5%       | Value is possibly 'null'                     |
| TS2307     | 1     | 0.2%       | Cannot find module                           |
| TS2353     | 1     | 0.2%       | Object literal has unknown properties        |
| TS2741     | 1     | 0.2%       | Property is missing in type                  |
| TS2538     | 1     | 0.2%       | TypeScript error                             |
| TS2540     | 1     | 0.2%       | Cannot assign to read-only property          |
| TS6138     | 1     | 0.2%       | Property declared but never used             |
| TS2740     | 1     | 0.2%       | Type is missing index signature              |
| TS7017     | 1     | 0.2%       | Type has no index signature                  |

## Deno Lint Rules Breakdown

| Rule Name       | Count | Percentage | Description                      |
| --------------- | ----- | ---------- | -------------------------------- |
| require-await   | 27    | 62.8%      | Async function without await     |
| no-unused-vars  | 13    | 30.2%      | Variable declared but never used |
| no-explicit-any | 3     | 7.0%       | Explicit 'any' type usage        |

## Biome Rules Breakdown

| Rule Name                               | Count | Percentage | Severity Distribution |
| --------------------------------------- | ----- | ---------- | --------------------- |
| correctness/useExhaustiveDependencies   | 23    | 21.9%      | 1E/22W                |
| style/useTemplate                       | 21    | 20.0%      | 21W                   |
| correctness/noUnusedVariables           | 18    | 17.1%      | 18W                   |
| complexity/noStaticOnlyClass            | 7     | 6.7%       | 7W                    |
| suspicious/noArrayIndexKey              | 7     | 6.7%       | 7W                    |
| complexity/useOptionalChain             | 5     | 4.8%       | 5W                    |
| correctness/noUnusedPrivateClassMembers | 3     | 2.9%       | 3W                    |
| suspicious/noExplicitAny                | 3     | 2.9%       | 3W                    |
| correctness/useParseIntRadix            | 2     | 1.9%       | 2W                    |
| complexity/useLiteralKeys               | 2     | 1.9%       | 2W                    |
| suspicious/noEmptyBlock                 | 2     | 1.9%       | 2W                    |
| correctness/noUnusedFunctionParameters  | 2     | 1.9%       | 2W                    |
| suspicious/noAssignInExpressions        | 2     | 1.9%       | 2W                    |
| complexity/noUselessFragments           | 1     | 1.0%       | 1W                    |
| complexity/noUselessSwitchCase          | 1     | 1.0%       | 1W                    |
| suspicious/noConfusingVoidType          | 1     | 1.0%       | 1W                    |
| complexity/noImportantStyles            | 1     | 1.0%       | 1W                    |
| suspicious/noIrregularWhitespace        | 1     | 1.0%       | 1W                    |
| suspicious/useIterableCallbackReturn    | 1     | 1.0%       | 1E                    |
| suspicious/noImplicitAnyLet             | 1     | 1.0%       | 1W                    |
| correctness/useHookAtTopLevel           | 1     | 1.0%       | 1W                    |

## Files with Most Issues

| File                                                   | Type Errors | Deno Lint | Biome | Total |
| ------------------------------------------------------ | ----------- | --------- | ----- | ----- |
| src/cli/utils/prompts.tsx                              | 5           | 11        | 8     | 24    |
| packages/client/src/client.ts                          | 23          | 0         | 0     | 23    |
| apps/atlasd/routes/streams/emit.ts                     | 21          | 0         | 0     | 21    |
| src/cli/commands/library/stats.tsx                     | 18          | 0         | 1     | 19    |
| src/cli/utils/conversation-client.ts                   | 13          | 3         | 3     | 19    |
| src/cli/utils/daemon-client.ts                         | 18          | 0         | 0     | 18    |
| apps/atlasd/routes/workspaces/index.ts                 | 16          | 0         | 0     | 16    |
| packages/storage/src/vector/vector-search-local.ts     | 14          | 0         | 1     | 15    |
| src/cli/modules/messages/message-buffer.tsx            | 11          | 0         | 4     | 15    |
| src/cli/commands/library/list.tsx                      | 12          | 0         | 0     | 12    |
| src/cli/commands/workspace/add.tsx                     | 0           | 0         | 11    | 11    |
| packages/cron/src/cron-manager.ts                      | 10          | 0         | 0     | 10    |
| packages/signals/src/providers/k8s-auth.ts             | 5           | 1         | 4     | 10    |
| src/core/storage/memory-kv-storage.ts                  | 2           | 8         | 0     | 10    |
| apps/web-client/src/lib/modules/client/conversation.ts | 8           | 0         | 1     | 9     |
| packages/core/src/orchestrator/agent-orchestrator.ts   | 9           | 0         | 0     | 9     |
| packages/signals/src/providers/http-webhook.ts         | 5           | 4         | 0     | 9     |
| src/cli/utils/output.ts                                | 3           | 3         | 3     | 9     |
| src/core/storage/deno-kv-storage.ts                    | 7           | 1         | 1     | 9     |
| packages/core/src/mcp-registry/web-discovery.ts        | 5           | 1         | 2     | 8     |
| ... and 104 more files                                 |             |           |       |       |

## Issues by Project

| Project                 | Type Errors | Deno Lint | Biome | Total |
| ----------------------- | ----------- | --------- | ----- | ----- |
| src                     | 159         | 28        | 72    | 259   |
| packages/core           | 55          | 3         | 6     | 64    |
| apps/atlasd             | 57          | 0         | 2     | 59    |
| packages/signals        | 23          | 6         | 7     | 36    |
| packages/client         | 26          | 0         | 0     | 26    |
| packages/storage        | 20          | 5         | 1     | 26    |
| apps/web-client         | 17          | 0         | 2     | 19    |
| other                   | 12          | 0         | 2     | 14    |
| packages/cron           | 10          | 0         | 0     | 10    |
| packages/notifications  | 9           | 0         | 0     | 9     |
| packages/system         | 8           | 0         | 0     | 8     |
| tools/atlas-installer   | 0           | 0         | 8     | 8     |
| packages/mcp-server     | 6           | 0         | 0     | 6     |
| packages/mcp            | 4           | 0         | 1     | 5     |
| packages/openapi-client | 1           | 0         | 2     | 3     |
| packages/memory         | 0           | 1         | 2     | 3     |
| packages/agent-sdk      | 2           | 0         | 0     | 2     |
| packages/workspace      | 1           | 0         | 0     | 1     |

## Workspace Dependency Graph

### Dependency Analysis

| Package                 | Dependencies                                                                  | Dependents                                                                                                                    | Complexity Score |
| ----------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| logger                  | utils                                                                         | diagnostics, atlasd, agent-sdk, core, memory, signals, workspace, mcp, bundled-agents, system, fs-watch, notifications, evals | 27               |
| utils                   | none                                                                          | diagnostics, atlasd, core, logger, memory, config, mcp-server, bundled-agents, storage, system, client, evals                 | 24               |
| core                    | config, logger, mcp, utils, agent-sdk, bundled-agents, oapi-client, memory    | web-client, atlasd, agent-sdk, mcp-server, client, evals                                                                      | 20               |
| atlasd                  | core, logger, utils, config, workspace, storage, cron, mcp-server, memory     | mcp-server, mcp, client, openapi-client, evals                                                                                | 19               |
| config                  | utils, agent-sdk, storage                                                     | atlasd, core, workspace, mcp-server, system, notifications                                                                    | 15               |
| memory                  | storage, logger, utils                                                        | atlasd, core, storage, system, memory_manager                                                                                 | 13               |
| workspace               | config, logger, storage, system, fs-watch                                     | diagnostics, atlasd, cron, memory_manager                                                                                     | 13               |
| agent-sdk               | logger, core                                                                  | core, config, bundled-agents, system, evals                                                                                   | 12               |
| system                  | logger, config, agent-sdk, bundled-agents, utils, oapi-client, memory, client | workspace, evals                                                                                                              | 12               |
| client                  | utils, atlasd, core                                                           | diagnostics, web-client, mcp-server, system                                                                                   | 11               |
| storage                 | memory, utils                                                                 | atlasd, memory, config, workspace                                                                                             | 10               |
| mcp-server              | client, utils, core, oapi-client, notifications, config, atlasd               | atlasd                                                                                                                        | 9                |
| bundled-agents          | agent-sdk, logger, utils                                                      | core, system, evals                                                                                                           | 9                |
| evals                   | bundled-agents, system, oapi-client, agent-sdk, logger, atlasd, core, utils   | none                                                                                                                          | 8                |
| diagnostics             | utils, client, logger, workspace                                              | none                                                                                                                          | 4                |
| mcp                     | logger, atlasd                                                                | core                                                                                                                          | 4                |
| notifications           | config, logger                                                                | mcp-server                                                                                                                    | 4                |
| web-client              | client, core, oapi-client                                                     | none                                                                                                                          | 3                |
| fs-watch                | logger                                                                        | workspace                                                                                                                     | 3                |
| cron                    | workspace                                                                     | atlasd                                                                                                                        | 3                |
| memory_manager          | memory, workspace                                                             | none                                                                                                                          | 2                |
| signals                 | logger                                                                        | none                                                                                                                          | 1                |
| openapi-client          | atlasd                                                                        | none                                                                                                                          | 1                |
| typescript-error-report | none                                                                          | none                                                                                                                          | 0                |
| src                     | none                                                                          | none                                                                                                                          | 0                |

### Recommended Fix Order

Based on the dependency graph, here's a recommended order for fixing errors:

1. **Start with leaf nodes** (no other packages depend on these):
   - web-client (17 errors)
   - signals (23 errors)
   - openapi-client (1 errors)

2. **Then fix middle-tier packages** (1-3 dependents):
   - mcp-server (6 errors, 1 dependents)
   - mcp (4 errors, 1 dependents)
   - system (8 errors, 2 dependents)
   - notifications (9 errors, 1 dependents)
   - cron (10 errors, 1 dependents)

3. **Finally, fix core packages** (many packages depend on these):
   - atlasd (57 errors, 5 dependents)
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

- **[Type] TS2345**: "Argument of type 'unknown' is not assignable to pa..."
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

- **[Type] TS7053**: "Element implicitly has an 'any' type because expre..."
  - Occurrences: 6
  - Files affected: 4

- **[Type] TS2322**: "Type 'unknown' is not assignable to type 'Record<s..."
  - Occurrences: 5
  - Files affected: 4

- **[Biome] correctness/useExhaustiveDependencies**: "This hook specifies more
  dependencies than necessa..."
  - Occurrences: 4
  - Files affected: 3

- **[Type] TS2345**: "Argument of type '"/api/sessions/{sessionId}"' is ..."
  - Occurrences: 3
  - Files affected: 3

- **[Type] TS18046**: "'errorData' is of type 'unknown'...."
  - Occurrences: 3
  - Files affected: 3

### High-Impact Files

Files with issues from multiple tools (need attention):

| File                                                   | Type Errors | Deno Lint | Biome | Total |
| ------------------------------------------------------ | ----------- | --------- | ----- | ----- |
| src/cli/utils/prompts.tsx                              | 5           | 11        | 8     | 24    |
| src/cli/commands/library/stats.tsx                     | 18          | 0         | 1     | 19    |
| src/cli/utils/conversation-client.ts                   | 13          | 3         | 3     | 19    |
| packages/storage/src/vector/vector-search-local.ts     | 14          | 0         | 1     | 15    |
| src/cli/modules/messages/message-buffer.tsx            | 11          | 0         | 4     | 15    |
| packages/signals/src/providers/k8s-auth.ts             | 5           | 1         | 4     | 10    |
| src/core/storage/memory-kv-storage.ts                  | 2           | 8         | 0     | 10    |
| apps/web-client/src/lib/modules/client/conversation.ts | 8           | 0         | 1     | 9     |
| packages/signals/src/providers/http-webhook.ts         | 5           | 4         | 0     | 9     |
| src/cli/utils/output.ts                                | 3           | 3         | 3     | 9     |
