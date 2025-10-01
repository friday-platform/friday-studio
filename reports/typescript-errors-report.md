# TypeScript & Lint Analysis Report

**Generated:** 2025-10-01T17:21:03.531Z

**Total Issues:** 417 (311 type errors, 20 deno lint violations, 86 biome
violations)

## Summary Statistics

### TypeScript Errors

- **Total errors:** 311
- **Unique error types:** 26
- **Files with errors:** 74

### Deno Lint Violations

- **Total violations:** 20
- **Unique rules violated:** 4
- **Files with violations:** 9

### Biome Violations

- **Total violations:** 86
- **Errors:** 1
- **Warnings:** 85
- **Unique rules violated:** 23
- **Files with violations:** 45

## TypeScript Error Types Breakdown

| Error Code | Count | Percentage | Description                                  |
| ---------- | ----- | ---------- | -------------------------------------------- |
| TS2339     | 86    | 27.7%      | Property does not exist on type              |
| TS2322     | 64    | 20.6%      | Type not assignable                          |
| TS18046    | 44    | 14.1%      | Value is of type 'unknown'                   |
| TS2345     | 34    | 10.9%      | Argument type not assignable                 |
| TS18048    | 18    | 5.8%       | Value is possibly 'undefined'                |
| TS7006     | 7     | 2.3%       | Parameter implicitly has any type            |
| TS6196     | 7     | 2.3%       | Catch clause variable unused                 |
| TS7053     | 6     | 1.9%       | Element implicitly has any type              |
| TS2531     | 6     | 1.9%       | Object is possibly 'null'                    |
| TS2694     | 6     | 1.9%       | Namespace has no exported member             |
| TS2532     | 5     | 1.6%       | Object is possibly 'undefined'               |
| TS2554     | 4     | 1.3%       | Argument count mismatch                      |
| TS2305     | 3     | 1.0%       | Module has no exported member                |
| TS2578     | 3     | 1.0%       | Unused ts-expect-error directive             |
| TS6236     | 3     | 1.0%       | TypeScript error                             |
| TS2769     | 2     | 0.6%       | No overload matches call                     |
| TS2739     | 2     | 0.6%       | Type is missing properties                   |
| TS4104     | 2     | 0.6%       | Parameter property readonly/mutable conflict |
| TS18047    | 2     | 0.6%       | Value is possibly 'null'                     |
| TS6133     | 1     | 0.3%       | Variable declared but never used             |
| TS2741     | 1     | 0.3%       | Property is missing in type                  |
| TS2538     | 1     | 0.3%       | TypeScript error                             |
| TS2698     | 1     | 0.3%       | Spread types may only be object types        |
| TS2367     | 1     | 0.3%       | TypeScript error                             |
| TS2740     | 1     | 0.3%       | Type is missing index signature              |
| TS7017     | 1     | 0.3%       | Type has no index signature                  |

## Deno Lint Rules Breakdown

| Rule Name        | Count | Percentage | Description                  |
| ---------------- | ----- | ---------- | ---------------------------- |
| require-await    | 15    | 75.0%      | Async function without await |
| no-explicit-any  | 2     | 10.0%      | Explicit 'any' type usage    |
| no-fallthrough   | 2     | 10.0%      | Case statement fallthrough   |
| no-global-assign | 1     | 5.0%       | Global variable assignment   |

## Biome Rules Breakdown

| Rule Name                               | Count | Percentage | Severity Distribution |
| --------------------------------------- | ----- | ---------- | --------------------- |
| correctness/useExhaustiveDependencies   | 22    | 25.6%      | 1E/21W                |
| style/useTemplate                       | 16    | 18.6%      | 16W                   |
| correctness/noUnusedVariables           | 8     | 9.3%       | 8W                    |
| suspicious/noArrayIndexKey              | 7     | 8.1%       | 7W                    |
| complexity/useOptionalChain             | 6     | 7.0%       | 6W                    |
| complexity/noStaticOnlyClass            | 5     | 5.8%       | 5W                    |
| correctness/useParseIntRadix            | 2     | 2.3%       | 2W                    |
| suspicious/noEmptyBlock                 | 2     | 2.3%       | 2W                    |
| suspicious/noExplicitAny                | 2     | 2.3%       | 2W                    |
| suspicious/noAssignInExpressions        | 2     | 2.3%       | 2W                    |
| suspicious/noFallthroughSwitchClause    | 2     | 2.3%       | 2W                    |
| complexity/noUselessFragments           | 1     | 1.2%       | 1W                    |
| complexity/noUselessSwitchCase          | 1     | 1.2%       | 1W                    |
| complexity/useLiteralKeys               | 1     | 1.2%       | 1W                    |
| correctness/noUnusedPrivateClassMembers | 1     | 1.2%       | 1W                    |
| suspicious/noConfusingVoidType          | 1     | 1.2%       | 1W                    |
| style/noNonNullAssertion                | 1     | 1.2%       | 1W                    |
| suspicious/noTsIgnore                   | 1     | 1.2%       | 1W                    |
| suspicious/noIrregularWhitespace        | 1     | 1.2%       | 1W                    |
| complexity/noImportantStyles            | 1     | 1.2%       | 1W                    |
| suspicious/noGlobalAssign               | 1     | 1.2%       | 1W                    |
| suspicious/useIterableCallbackReturn    | 1     | 1.2%       | 1W                    |
| correctness/useHookAtTopLevel           | 1     | 1.2%       | 1W                    |

## Files with Most Issues

| File                                                      | Type Errors | Deno Lint | Biome | Total |
| --------------------------------------------------------- | ----------- | --------- | ----- | ----- |
| packages/client/src/client.ts                             | 23          | 0         | 0     | 23    |
| apps/atlasd/routes/streams/emit.ts                        | 21          | 0         | 0     | 21    |
| src/cli/commands/library/stats.tsx                        | 18          | 0         | 1     | 19    |
| src/cli/utils/daemon-client.ts                            | 18          | 0         | 0     | 18    |
| src/cli/modules/messages/message-buffer.tsx               | 12          | 0         | 4     | 16    |
| src/cli/utils/conversation-client.ts                      | 10          | 2         | 2     | 14    |
| packages/system/agents/conversation/conversation.agent.ts | 7           | 2         | 3     | 12    |
| src/cli/commands/library/list.tsx                         | 12          | 0         | 0     | 12    |
| apps/web-client/src/lib/modules/client/conversation.ts    | 8           | 1         | 2     | 11    |
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
| src/core/workspace-runtime-machine.ts                     | 7           | 0         | 0     | 7     |
| ... and 83 more files                                     |             |           |       |       |

## Issues by Project

| Project                 | Type Errors | Deno Lint | Biome | Total |
| ----------------------- | ----------- | --------- | ----- | ----- |
| src                     | 149         | 15        | 56    | 220   |
| packages/core           | 36          | 2         | 8     | 46    |
| apps/atlasd             | 39          | 0         | 2     | 41    |
| packages/client         | 26          | 0         | 0     | 26    |
| apps/web-client         | 16          | 1         | 3     | 20    |
| packages/system         | 9           | 2         | 3     | 14    |
| other                   | 11          | 0         | 2     | 13    |
| packages/notifications  | 9           | 0         | 0     | 9     |
| tools/atlas-installer   | 0           | 0         | 9     | 9     |
| packages/mcp-server     | 6           | 0         | 0     | 6     |
| packages/mcp            | 4           | 0         | 1     | 5     |
| packages/agent-sdk      | 4           | 0         | 0     | 4     |
| packages/openapi-client | 1           | 0         | 2     | 3     |
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
   - system (9 errors, 2 dependents)
   - notifications (9 errors, 1 dependents)

3. **Finally, fix core packages** (many packages depend on these):
   - atlasd (39 errors, 5 dependents)
   - agent-sdk (4 errors, 6 dependents)
   - core (36 errors, 8 dependents)
   - workspace (1 errors, 4 dependents)
   - client (26 errors, 4 dependents)

## Code Quality Hotspots Analysis

### Most Common Issue Patterns

Issues that appear across multiple files (potential systematic problems):

- **[Biome] style/useTemplate**: "Template literals are preferred over string
  concat..."
  - Occurrences: 16
  - Files affected: 12

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

- **[Type] TS2532**: "Object is possibly 'undefined'...."
  - Occurrences: 5
  - Files affected: 3

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

- **[Type] TS2578**: "Unused '@ts-expect-error' directive...."
  - Occurrences: 3
  - Files affected: 3

### High-Impact Files

Files with issues from multiple tools (need attention):

| File                                                      | Type Errors | Deno Lint | Biome | Total |
| --------------------------------------------------------- | ----------- | --------- | ----- | ----- |
| src/cli/commands/library/stats.tsx                        | 18          | 0         | 1     | 19    |
| src/cli/modules/messages/message-buffer.tsx               | 12          | 0         | 4     | 16    |
| src/cli/utils/conversation-client.ts                      | 10          | 2         | 2     | 14    |
| packages/system/agents/conversation/conversation.agent.ts | 7           | 2         | 3     | 12    |
| apps/web-client/src/lib/modules/client/conversation.ts    | 8           | 1         | 2     | 11    |
| src/core/storage/memory-kv-storage.ts                     | 2           | 8         | 0     | 10    |
| src/core/library/types.ts                                 | 4           | 0         | 4     | 8     |
| src/utils/telemetry.ts                                    | 5           | 0         | 3     | 8     |
| src/cli/commands/agent/describe.tsx                       | 3           | 0         | 4     | 7     |
| src/cli/commands/workspace/list.tsx                       | 5           | 0         | 2     | 7     |
