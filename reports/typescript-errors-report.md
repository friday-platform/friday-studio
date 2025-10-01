# TypeScript & Lint Analysis Report

**Generated:** 2025-10-01T16:58:31.707Z

**Total Issues:** 452 (332 type errors, 27 deno lint violations, 93 biome
violations)

## Summary Statistics

### TypeScript Errors

- **Total errors:** 332
- **Unique error types:** 27
- **Files with errors:** 77

### Deno Lint Violations

- **Total violations:** 27
- **Unique rules violated:** 4
- **Files with violations:** 13

### Biome Violations

- **Total violations:** 93
- **Errors:** 1
- **Warnings:** 92
- **Unique rules violated:** 23
- **Files with violations:** 50

## TypeScript Error Types Breakdown

| Error Code | Count | Percentage | Description                                  |
| ---------- | ----- | ---------- | -------------------------------------------- |
| TS2339     | 86    | 25.9%      | Property does not exist on type              |
| TS2322     | 66    | 19.9%      | Type not assignable                          |
| TS18046    | 46    | 13.9%      | Value is of type 'unknown'                   |
| TS2345     | 35    | 10.5%      | Argument type not assignable                 |
| TS18048    | 20    | 6.0%       | Value is possibly 'undefined'                |
| TS2532     | 14    | 4.2%       | Object is possibly 'undefined'               |
| TS7006     | 7     | 2.1%       | Parameter implicitly has any type            |
| TS6196     | 7     | 2.1%       | Catch clause variable unused                 |
| TS7053     | 6     | 1.8%       | Element implicitly has any type              |
| TS2531     | 6     | 1.8%       | Object is possibly 'null'                    |
| TS2694     | 6     | 1.8%       | Namespace has no exported member             |
| TS2571     | 5     | 1.5%       | Object is of type 'unknown'                  |
| TS2554     | 4     | 1.2%       | Argument count mismatch                      |
| TS2305     | 3     | 0.9%       | Module has no exported member                |
| TS6236     | 3     | 0.9%       | TypeScript error                             |
| TS6133     | 2     | 0.6%       | Variable declared but never used             |
| TS2769     | 2     | 0.6%       | No overload matches call                     |
| TS2739     | 2     | 0.6%       | Type is missing properties                   |
| TS2578     | 2     | 0.6%       | Unused ts-expect-error directive             |
| TS4104     | 2     | 0.6%       | Parameter property readonly/mutable conflict |
| TS18047    | 2     | 0.6%       | Value is possibly 'null'                     |
| TS2741     | 1     | 0.3%       | Property is missing in type                  |
| TS2538     | 1     | 0.3%       | TypeScript error                             |
| TS2698     | 1     | 0.3%       | Spread types may only be object types        |
| TS2367     | 1     | 0.3%       | TypeScript error                             |
| TS2740     | 1     | 0.3%       | Type is missing index signature              |
| TS7017     | 1     | 0.3%       | Type has no index signature                  |

## Deno Lint Rules Breakdown

| Rule Name        | Count | Percentage | Description                  |
| ---------------- | ----- | ---------- | ---------------------------- |
| require-await    | 22    | 81.5%      | Async function without await |
| no-fallthrough   | 2     | 7.4%       | Case statement fallthrough   |
| no-explicit-any  | 2     | 7.4%       | Explicit 'any' type usage    |
| no-global-assign | 1     | 3.7%       | Global variable assignment   |

## Biome Rules Breakdown

| Rule Name                               | Count | Percentage | Severity Distribution |
| --------------------------------------- | ----- | ---------- | --------------------- |
| correctness/useExhaustiveDependencies   | 22    | 23.7%      | 1E/21W                |
| style/useTemplate                       | 21    | 22.6%      | 21W                   |
| correctness/noUnusedVariables           | 8     | 8.6%       | 8W                    |
| complexity/useOptionalChain             | 7     | 7.5%       | 7W                    |
| suspicious/noArrayIndexKey              | 7     | 7.5%       | 7W                    |
| complexity/noStaticOnlyClass            | 5     | 5.4%       | 5W                    |
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
| complexity/noImportantStyles            | 1     | 1.1%       | 1W                    |
| suspicious/noIrregularWhitespace        | 1     | 1.1%       | 1W                    |
| suspicious/noGlobalAssign               | 1     | 1.1%       | 1W                    |
| suspicious/useIterableCallbackReturn    | 1     | 1.1%       | 1W                    |
| correctness/useHookAtTopLevel           | 1     | 1.1%       | 1W                    |

## Files with Most Issues

| File                                                      | Type Errors | Deno Lint | Biome | Total |
| --------------------------------------------------------- | ----------- | --------- | ----- | ----- |
| packages/client/src/client.ts                             | 23          | 0         | 0     | 23    |
| apps/atlasd/routes/streams/emit.ts                        | 21          | 0         | 0     | 21    |
| src/cli/commands/library/stats.tsx                        | 18          | 0         | 1     | 19    |
| src/cli/utils/daemon-client.ts                            | 18          | 0         | 0     | 18    |
| src/cli/modules/messages/message-buffer.tsx               | 12          | 0         | 4     | 16    |
| packages/storage/src/vector/vector-search-local.ts        | 14          | 0         | 1     | 15    |
| src/cli/utils/conversation-client.ts                      | 10          | 2         | 2     | 14    |
| src/cli/commands/library/list.tsx                         | 12          | 0         | 0     | 12    |
| apps/web-client/src/lib/modules/client/conversation.ts    | 8           | 1         | 2     | 11    |
| packages/system/agents/conversation/conversation.agent.ts | 6           | 2         | 3     | 11    |
| src/cli/commands/workspace/add.tsx                        | 0           | 0         | 11    | 11    |
| src/core/storage/memory-kv-storage.ts                     | 2           | 8         | 0     | 10    |
| packages/core/src/orchestrator/agent-orchestrator.ts      | 9           | 0         | 0     | 9     |
| src/cli/commands/workspace/status.tsx                     | 8           | 0         | 0     | 8     |
| src/core/library/types.ts                                 | 4           | 0         | 4     | 8     |
| src/utils/telemetry.ts                                    | 5           | 0         | 3     | 8     |
| packages/notifications/src/notification-manager.ts        | 7           | 0         | 0     | 7     |
| src/cli/commands/agent/describe.tsx                       | 3           | 0         | 4     | 7     |
| src/cli/commands/workspace/list.tsx                       | 5           | 0         | 2     | 7     |
| src/core/providers/registry.ts                            | 6           | 1         | 0     | 7     |
| ... and 92 more files                                     |             |           |       |       |

## Issues by Project

| Project                 | Type Errors | Deno Lint | Biome | Total |
| ----------------------- | ----------- | --------- | ----- | ----- |
| src                     | 149         | 15        | 60    | 224   |
| packages/core           | 38          | 3         | 8     | 49    |
| apps/atlasd             | 39          | 0         | 2     | 41    |
| packages/client         | 26          | 0         | 0     | 26    |
| packages/storage        | 20          | 5         | 1     | 26    |
| apps/web-client         | 16          | 1         | 3     | 20    |
| other                   | 11          | 0         | 2     | 13    |
| packages/system         | 8           | 2         | 3     | 13    |
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

| Package                 | Dependencies                                                                                  | Dependents                                                                                                                         | Complexity Score |
| ----------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| utils                   | none                                                                                          | diagnostics, web-client, atlasd, core, logger, memory, config, signals, mcp-server, bundled-agents, storage, system, client, evals | 28               |
| logger                  | utils                                                                                         | diagnostics, atlasd, agent-sdk, core, memory, signals, workspace, mcp, bundled-agents, system, fs-watch, notifications, evals      | 27               |
| core                    | config, logger, mcp, utils, agent-sdk, bundled-agents, oapi-client, memory                    | web-client, atlasd, agent-sdk, mcp-server, bundled-agents, system, client, evals                                                   | 24               |
| atlasd                  | core, logger, utils, config, workspace, storage, agent-sdk, cron, mcp-server, memory, signals | mcp-server, mcp, client, openapi-client, evals                                                                                     | 21               |
| config                  | utils, agent-sdk, storage                                                                     | atlasd, core, workspace, mcp-server, system, notifications                                                                         | 15               |
| agent-sdk               | logger, core                                                                                  | atlasd, core, config, bundled-agents, system, evals                                                                                | 14               |
| memory                  | storage, logger, utils                                                                        | atlasd, core, storage, system, memory_manager                                                                                      | 13               |
| workspace               | config, logger, storage, system, fs-watch                                                     | diagnostics, atlasd, cron, memory_manager                                                                                          | 13               |
| system                  | core, logger, config, agent-sdk, bundled-agents, utils, oapi-client, memory, client           | workspace, evals                                                                                                                   | 13               |
| client                  | utils, atlasd, core                                                                           | diagnostics, web-client, mcp-server, system                                                                                        | 11               |
| bundled-agents          | core, agent-sdk, logger, utils                                                                | core, system, evals                                                                                                                | 10               |
| storage                 | memory, utils                                                                                 | atlasd, memory, config, workspace                                                                                                  | 10               |
| mcp-server              | client, utils, core, oapi-client, notifications, config, atlasd                               | atlasd                                                                                                                             | 9                |
| evals                   | bundled-agents, system, oapi-client, agent-sdk, logger, atlasd, core, utils                   | none                                                                                                                               | 8                |
| diagnostics             | utils, client, logger, workspace                                                              | none                                                                                                                               | 4                |
| web-client              | client, core, oapi-client, utils                                                              | none                                                                                                                               | 4                |
| signals                 | logger, utils                                                                                 | atlasd                                                                                                                             | 4                |
| mcp                     | logger, atlasd                                                                                | core                                                                                                                               | 4                |
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
   - web-client (16 errors)
   - openapi-client (1 errors)

2. **Then fix middle-tier packages** (1-3 dependents):
   - mcp-server (6 errors, 1 dependents)
   - mcp (4 errors, 1 dependents)
   - system (8 errors, 2 dependents)
   - notifications (9 errors, 1 dependents)

3. **Finally, fix core packages** (many packages depend on these):
   - atlasd (39 errors, 5 dependents)
   - agent-sdk (4 errors, 6 dependents)
   - core (38 errors, 8 dependents)
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
  - Occurrences: 8
  - Files affected: 4

- **[Biome] suspicious/noArrayIndexKey**: "Avoid using the index of an array as
  key property ..."
  - Occurrences: 7
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

- **[Type] TS2345**: "Argument of type 'unknown' is not assignable to pa..."
  - Occurrences: 3
  - Files affected: 3

- **[Type] TS2345**: "Argument of type '"/api/sessions/{sessionId}"' is ..."
  - Occurrences: 3
  - Files affected: 3

- **[Type] TS18046**: "'errorData' is of type 'unknown'...."
  - Occurrences: 3
  - Files affected: 3

- **[Type] TS2322**: "Type 'unknown' is not assignable to type 'Record<s..."
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
| apps/web-client/src/lib/modules/client/conversation.ts    | 8           | 1         | 2     | 11    |
| packages/system/agents/conversation/conversation.agent.ts | 6           | 2         | 3     | 11    |
| src/core/storage/memory-kv-storage.ts                     | 2           | 8         | 0     | 10    |
| src/core/library/types.ts                                 | 4           | 0         | 4     | 8     |
| src/utils/telemetry.ts                                    | 5           | 0         | 3     | 8     |
| src/cli/commands/agent/describe.tsx                       | 3           | 0         | 4     | 7     |
