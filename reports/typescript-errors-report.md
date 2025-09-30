# TypeScript & Lint Analysis Report

**Generated:** 2025-09-30T00:20:09.045Z

**Total Issues:** 471 (354 type errors, 26 deno lint violations, 91 biome
violations)

## Summary Statistics

### TypeScript Errors

- **Total errors:** 354
- **Unique error types:** 29
- **Files with errors:** 80

### Deno Lint Violations

- **Total violations:** 26
- **Unique rules violated:** 3
- **Files with violations:** 12

### Biome Violations

- **Total violations:** 91
- **Errors:** 2
- **Warnings:** 89
- **Unique rules violated:** 22
- **Files with violations:** 49

## TypeScript Error Types Breakdown

| Error Code | Count | Percentage | Description                                  |
| ---------- | ----- | ---------- | -------------------------------------------- |
| TS2339     | 86    | 24.3%      | Property does not exist on type              |
| TS2322     | 71    | 20.1%      | Type not assignable                          |
| TS18046    | 54    | 15.3%      | Value is of type 'unknown'                   |
| TS2345     | 40    | 11.3%      | Argument type not assignable                 |
| TS18048    | 20    | 5.6%       | Value is possibly 'undefined'                |
| TS2532     | 14    | 4.0%       | Object is possibly 'undefined'               |
| TS7006     | 7     | 2.0%       | Parameter implicitly has any type            |
| TS6196     | 7     | 2.0%       | Catch clause variable unused                 |
| TS7053     | 6     | 1.7%       | Element implicitly has any type              |
| TS2531     | 6     | 1.7%       | Object is possibly 'null'                    |
| TS2694     | 6     | 1.7%       | Namespace has no exported member             |
| TS2571     | 5     | 1.4%       | Object is of type 'unknown'                  |
| TS2305     | 3     | 0.8%       | Module has no exported member                |
| TS2578     | 3     | 0.8%       | Unused ts-expect-error directive             |
| TS2554     | 3     | 0.8%       | Argument count mismatch                      |
| TS6236     | 3     | 0.8%       | TypeScript error                             |
| TS2307     | 2     | 0.6%       | Cannot find module                           |
| TS2367     | 2     | 0.6%       | TypeScript error                             |
| TS6133     | 2     | 0.6%       | Variable declared but never used             |
| TS2769     | 2     | 0.6%       | No overload matches call                     |
| TS2739     | 2     | 0.6%       | Type is missing properties                   |
| TS4104     | 2     | 0.6%       | Parameter property readonly/mutable conflict |
| TS18047    | 2     | 0.6%       | Value is possibly 'null'                     |
| TS2589     | 1     | 0.3%       | TypeScript error                             |
| TS2741     | 1     | 0.3%       | Property is missing in type                  |
| TS2538     | 1     | 0.3%       | TypeScript error                             |
| TS2698     | 1     | 0.3%       | Spread types may only be object types        |
| TS2740     | 1     | 0.3%       | Type is missing index signature              |
| TS7017     | 1     | 0.3%       | Type has no index signature                  |

## Deno Lint Rules Breakdown

| Rule Name       | Count | Percentage | Description                  |
| --------------- | ----- | ---------- | ---------------------------- |
| require-await   | 22    | 84.6%      | Async function without await |
| no-explicit-any | 2     | 7.7%       | Explicit 'any' type usage    |
| no-fallthrough  | 2     | 7.7%       | Case statement fallthrough   |

## Biome Rules Breakdown

| Rule Name                               | Count | Percentage | Severity Distribution |
| --------------------------------------- | ----- | ---------- | --------------------- |
| correctness/useExhaustiveDependencies   | 22    | 24.2%      | 1E/21W                |
| style/useTemplate                       | 21    | 23.1%      | 21W                   |
| complexity/useOptionalChain             | 7     | 7.7%       | 7W                    |
| correctness/noUnusedVariables           | 7     | 7.7%       | 7W                    |
| suspicious/noArrayIndexKey              | 7     | 7.7%       | 7W                    |
| complexity/noStaticOnlyClass            | 5     | 5.5%       | 5W                    |
| correctness/useParseIntRadix            | 2     | 2.2%       | 2W                    |
| correctness/noUnusedPrivateClassMembers | 2     | 2.2%       | 2W                    |
| suspicious/noEmptyBlock                 | 2     | 2.2%       | 2W                    |
| suspicious/noExplicitAny                | 2     | 2.2%       | 2W                    |
| suspicious/noAssignInExpressions        | 2     | 2.2%       | 2W                    |
| suspicious/noFallthroughSwitchClause    | 2     | 2.2%       | 2W                    |
| complexity/noUselessFragments           | 1     | 1.1%       | 1W                    |
| complexity/noUselessSwitchCase          | 1     | 1.1%       | 1W                    |
| complexity/useLiteralKeys               | 1     | 1.1%       | 1W                    |
| suspicious/noConfusingVoidType          | 1     | 1.1%       | 1W                    |
| style/noNonNullAssertion                | 1     | 1.1%       | 1W                    |
| suspicious/noTsIgnore                   | 1     | 1.1%       | 1W                    |
| suspicious/noIrregularWhitespace        | 1     | 1.1%       | 1W                    |
| complexity/noImportantStyles            | 1     | 1.1%       | 1W                    |
| suspicious/useIterableCallbackReturn    | 1     | 1.1%       | 1E                    |
| correctness/useHookAtTopLevel           | 1     | 1.1%       | 1W                    |

## Files with Most Issues

| File                                                      | Type Errors | Deno Lint | Biome | Total |
| --------------------------------------------------------- | ----------- | --------- | ----- | ----- |
| packages/client/src/client.ts                             | 23          | 0         | 0     | 23    |
| apps/atlasd/routes/streams/emit.ts                        | 21          | 0         | 0     | 21    |
| src/cli/commands/library/stats.tsx                        | 18          | 0         | 1     | 19    |
| src/cli/utils/daemon-client.ts                            | 18          | 0         | 0     | 18    |
| apps/atlasd/routes/workspaces/index.ts                    | 16          | 0         | 0     | 16    |
| src/cli/modules/messages/message-buffer.tsx               | 12          | 0         | 4     | 16    |
| packages/storage/src/vector/vector-search-local.ts        | 14          | 0         | 1     | 15    |
| src/cli/utils/conversation-client.ts                      | 10          | 2         | 2     | 14    |
| packages/system/agents/conversation/conversation.agent.ts | 7           | 2         | 3     | 12    |
| src/cli/commands/library/list.tsx                         | 12          | 0         | 0     | 12    |
| src/cli/commands/workspace/add.tsx                        | 0           | 0         | 11    | 11    |
| src/core/storage/memory-kv-storage.ts                     | 2           | 8         | 0     | 10    |
| apps/web-client/src/lib/modules/client/conversation.ts    | 8           | 0         | 1     | 9     |
| packages/core/src/orchestrator/agent-orchestrator.ts      | 9           | 0         | 0     | 9     |
| src/cli/commands/workspace/status.tsx                     | 8           | 0         | 0     | 8     |
| src/core/library/types.ts                                 | 4           | 0         | 4     | 8     |
| src/utils/telemetry.ts                                    | 5           | 0         | 3     | 8     |
| packages/notifications/src/notification-manager.ts        | 7           | 0         | 0     | 7     |
| src/cli/commands/agent/describe.tsx                       | 3           | 0         | 4     | 7     |
| src/cli/commands/workspace/list.tsx                       | 5           | 0         | 2     | 7     |
| ... and 95 more files                                     |             |           |       |       |

## Issues by Project

| Project                 | Type Errors | Deno Lint | Biome | Total |
| ----------------------- | ----------- | --------- | ----- | ----- |
| src                     | 149         | 15        | 60    | 224   |
| apps/atlasd             | 58          | 0         | 2     | 60    |
| packages/core           | 36          | 3         | 7     | 46    |
| packages/client         | 26          | 0         | 0     | 26    |
| packages/storage        | 20          | 5         | 1     | 26    |
| apps/web-client         | 20          | 0         | 2     | 22    |
| packages/system         | 9           | 2         | 3     | 14    |
| other                   | 11          | 0         | 2     | 13    |
| packages/notifications  | 9           | 0         | 0     | 9     |
| tools/atlas-installer   | 0           | 0         | 9     | 9     |
| packages/mcp-server     | 6           | 0         | 0     | 6     |
| packages/mcp            | 4           | 0         | 1     | 5     |
| packages/agent-sdk      | 4           | 0         | 0     | 4     |
| packages/openapi-client | 1           | 0         | 2     | 3     |
| packages/memory         | 0           | 1         | 2     | 3     |
| packages/workspace      | 1           | 0         | 0     | 1     |

## Workspace Dependency Graph

### Dependency Analysis

| Package                 | Dependencies                                                                        | Dependents                                                                                                                    | Complexity Score |
| ----------------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| logger                  | utils                                                                               | diagnostics, atlasd, agent-sdk, core, memory, signals, workspace, mcp, bundled-agents, system, fs-watch, notifications, evals | 27               |
| utils                   | none                                                                                | diagnostics, atlasd, core, logger, memory, config, signals, mcp-server, bundled-agents, storage, system, client, evals        | 26               |
| core                    | config, logger, mcp, utils, agent-sdk, bundled-agents, oapi-client, memory          | web-client, atlasd, agent-sdk, mcp-server, system, client, evals                                                              | 22               |
| atlasd                  | core, logger, utils, config, workspace, storage, cron, mcp-server, memory           | mcp-server, mcp, client, openapi-client, evals                                                                                | 19               |
| config                  | utils, agent-sdk, storage                                                           | atlasd, core, workspace, mcp-server, system, notifications                                                                    | 15               |
| memory                  | storage, logger, utils                                                              | atlasd, core, storage, system, memory_manager                                                                                 | 13               |
| workspace               | config, logger, storage, system, fs-watch                                           | diagnostics, atlasd, cron, memory_manager                                                                                     | 13               |
| system                  | logger, config, agent-sdk, bundled-agents, utils, oapi-client, memory, client, core | workspace, evals                                                                                                              | 13               |
| agent-sdk               | logger, core                                                                        | core, config, bundled-agents, system, evals                                                                                   | 12               |
| client                  | utils, atlasd, core                                                                 | diagnostics, web-client, mcp-server, system                                                                                   | 11               |
| storage                 | memory, utils                                                                       | atlasd, memory, config, workspace                                                                                             | 10               |
| mcp-server              | client, utils, core, oapi-client, notifications, config, atlasd                     | atlasd                                                                                                                        | 9                |
| bundled-agents          | agent-sdk, logger, utils                                                            | core, system, evals                                                                                                           | 9                |
| evals                   | bundled-agents, system, oapi-client, agent-sdk, logger, atlasd, core, utils         | none                                                                                                                          | 8                |
| diagnostics             | utils, client, logger, workspace                                                    | none                                                                                                                          | 4                |
| mcp                     | logger, atlasd                                                                      | core                                                                                                                          | 4                |
| notifications           | config, logger                                                                      | mcp-server                                                                                                                    | 4                |
| web-client              | client, core, oapi-client                                                           | none                                                                                                                          | 3                |
| fs-watch                | logger                                                                              | workspace                                                                                                                     | 3                |
| cron                    | workspace                                                                           | atlasd                                                                                                                        | 3                |
| signals                 | logger, utils                                                                       | none                                                                                                                          | 2                |
| memory_manager          | memory, workspace                                                                   | none                                                                                                                          | 2                |
| openapi-client          | atlasd                                                                              | none                                                                                                                          | 1                |
| typescript-error-report | none                                                                                | none                                                                                                                          | 0                |
| src                     | none                                                                                | none                                                                                                                          | 0                |

### Recommended Fix Order

Based on the dependency graph, here's a recommended order for fixing errors:

1. **Start with leaf nodes** (no other packages depend on these):
   - web-client (20 errors)
   - openapi-client (1 errors)

2. **Then fix middle-tier packages** (1-3 dependents):
   - mcp-server (6 errors, 1 dependents)
   - mcp (4 errors, 1 dependents)
   - system (9 errors, 2 dependents)
   - notifications (9 errors, 1 dependents)

3. **Finally, fix core packages** (many packages depend on these):
   - atlasd (58 errors, 5 dependents)
   - agent-sdk (4 errors, 5 dependents)
   - core (36 errors, 7 dependents)
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

- **[Type] TS2532**: "Object is possibly 'undefined'...."
  - Occurrences: 14
  - Files affected: 4

- **[Type] TS2345**: "Argument of type 'string | undefined' is not assig..."
  - Occurrences: 11
  - Files affected: 6

- **[Biome] correctness/noUnusedVariables**: "Unused variables are often the
  result of an incomp..."
  - Occurrences: 7
  - Files affected: 3

- **[Biome] suspicious/noArrayIndexKey**: "Avoid using the index of an array as
  key property ..."
  - Occurrences: 7
  - Files affected: 4

- **[Type] TS2345**: "Argument of type 'unknown' is not assignable to pa..."
  - Occurrences: 6
  - Files affected: 4

- **[Type] TS2322**: "Type 'unknown' is not assignable to type '{ id..."
  - Occurrences: 6
  - Files affected: 3

- **[Type] TS2339**: "Property 'capabilities' does not exist on type '{ ..."
  - Occurrences: 6
  - Files affected: 3

- **[Type] TS7053**: "Element implicitly has an 'any' type because expre..."
  - Occurrences: 6
  - Files affected: 4

- **[Biome] complexity/noStaticOnlyClass**: "Prefer using simple functions
  instead of classes w..."
  - Occurrences: 5
  - Files affected: 4

- **[Type] TS2345**: "Argument of type '"/api/sessions/{sessionId}"' is ..."
  - Occurrences: 3
  - Files affected: 3

- **[Type] TS18046**: "'errorData' is of type 'unknown'...."
  - Occurrences: 3
  - Files affected: 3

- **[Type] TS2322**: "Type 'unknown' is not assignable to type 'Record<s..."
  - Occurrences: 3
  - Files affected: 3

- **[Type] TS2578**: "Unused '@ts-expect-error' directive...."
  - Occurrences: 3
  - Files affected: 3

### High-Impact Files

Files with issues from multiple tools (need attention):

| File                                                      | Type Errors | Deno Lint | Biome | Total |
| --------------------------------------------------------- | ----------- | --------- | ----- | ----- |
| src/cli/commands/library/stats.tsx                        | 18          | 0         | 1     | 19    |
| src/cli/modules/messages/message-buffer.tsx               | 12          | 0         | 4     | 16    |
| packages/storage/src/vector/vector-search-local.ts        | 14          | 0         | 1     | 15    |
| src/cli/utils/conversation-client.ts                      | 10          | 2         | 2     | 14    |
| packages/system/agents/conversation/conversation.agent.ts | 7           | 2         | 3     | 12    |
| src/core/storage/memory-kv-storage.ts                     | 2           | 8         | 0     | 10    |
| apps/web-client/src/lib/modules/client/conversation.ts    | 8           | 0         | 1     | 9     |
| src/core/library/types.ts                                 | 4           | 0         | 4     | 8     |
| src/utils/telemetry.ts                                    | 5           | 0         | 3     | 8     |
| src/cli/commands/agent/describe.tsx                       | 3           | 0         | 4     | 7     |
