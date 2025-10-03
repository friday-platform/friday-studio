# TypeScript & Lint Analysis Report

**Generated:** 2025-10-03T04:01:32.967Z

**Total Issues:** 464 (353 type errors, 24 deno lint violations, 87 biome
violations)

## Summary Statistics

### TypeScript Errors

- **Total errors:** 353
- **Unique error types:** 26
- **Files with errors:** 85

### Deno Lint Violations

- **Total violations:** 24
- **Unique rules violated:** 4
- **Files with violations:** 10

### Biome Violations

- **Total violations:** 87
- **Errors:** 1
- **Warnings:** 86
- **Unique rules violated:** 23
- **Files with violations:** 47

## TypeScript Error Types Breakdown

| Error Code | Count | Percentage | Description                                  |
| ---------- | ----- | ---------- | -------------------------------------------- |
| TS2339     | 124   | 35.1%      | Property does not exist on type              |
| TS2322     | 62    | 17.6%      | Type not assignable                          |
| TS2345     | 44    | 12.5%      | Argument type not assignable                 |
| TS18046    | 42    | 11.9%      | Value is of type 'unknown'                   |
| TS18048    | 16    | 4.5%       | Value is possibly 'undefined'                |
| TS7006     | 9     | 2.5%       | Parameter implicitly has any type            |
| TS6196     | 7     | 2.0%       | Catch clause variable unused                 |
| TS2531     | 6     | 1.7%       | Object is possibly 'null'                    |
| TS2694     | 6     | 1.7%       | Namespace has no exported member             |
| TS2532     | 5     | 1.4%       | Object is possibly 'undefined'               |
| TS7053     | 4     | 1.1%       | Element implicitly has any type              |
| TS2554     | 4     | 1.1%       | Argument count mismatch                      |
| TS2305     | 3     | 0.8%       | Module has no exported member                |
| TS2578     | 3     | 0.8%       | Unused ts-expect-error directive             |
| TS6236     | 3     | 0.8%       | TypeScript error                             |
| TS6133     | 2     | 0.6%       | Variable declared but never used             |
| TS2769     | 2     | 0.6%       | No overload matches call                     |
| TS2739     | 2     | 0.6%       | Type is missing properties                   |
| TS4104     | 2     | 0.6%       | Parameter property readonly/mutable conflict |
| TS2307     | 1     | 0.3%       | Cannot find module                           |
| TS2741     | 1     | 0.3%       | Property is missing in type                  |
| TS2538     | 1     | 0.3%       | TypeScript error                             |
| TS2698     | 1     | 0.3%       | Spread types may only be object types        |
| TS2367     | 1     | 0.3%       | TypeScript error                             |
| TS2740     | 1     | 0.3%       | Type is missing index signature              |
| TS7017     | 1     | 0.3%       | Type has no index signature                  |

## Deno Lint Rules Breakdown

| Rule Name        | Count | Percentage | Description                  |
| ---------------- | ----- | ---------- | ---------------------------- |
| require-await    | 19    | 79.2%      | Async function without await |
| no-explicit-any  | 2     | 8.3%       | Explicit 'any' type usage    |
| no-fallthrough   | 2     | 8.3%       | Case statement fallthrough   |
| no-global-assign | 1     | 4.2%       | Global variable assignment   |

## Biome Rules Breakdown

| Rule Name                               | Count | Percentage | Severity Distribution |
| --------------------------------------- | ----- | ---------- | --------------------- |
| correctness/useExhaustiveDependencies   | 22    | 25.3%      | 1E/21W                |
| style/useTemplate                       | 16    | 18.4%      | 16W                   |
| correctness/noUnusedVariables           | 8     | 9.2%       | 8W                    |
| suspicious/noArrayIndexKey              | 7     | 8.0%       | 7W                    |
| complexity/noStaticOnlyClass            | 5     | 5.7%       | 5W                    |
| complexity/useOptionalChain             | 5     | 5.7%       | 5W                    |
| correctness/useParseIntRadix            | 2     | 2.3%       | 2W                    |
| correctness/noUnusedPrivateClassMembers | 2     | 2.3%       | 2W                    |
| suspicious/noEmptyBlock                 | 2     | 2.3%       | 2W                    |
| style/noNonNullAssertion                | 2     | 2.3%       | 2W                    |
| suspicious/noExplicitAny                | 2     | 2.3%       | 2W                    |
| suspicious/noAssignInExpressions        | 2     | 2.3%       | 2W                    |
| suspicious/noFallthroughSwitchClause    | 2     | 2.3%       | 2W                    |
| complexity/noUselessFragments           | 1     | 1.1%       | 1W                    |
| complexity/noUselessSwitchCase          | 1     | 1.1%       | 1W                    |
| complexity/useLiteralKeys               | 1     | 1.1%       | 1W                    |
| suspicious/noConfusingVoidType          | 1     | 1.1%       | 1W                    |
| suspicious/noTsIgnore                   | 1     | 1.1%       | 1W                    |
| suspicious/noIrregularWhitespace        | 1     | 1.1%       | 1W                    |
| complexity/noImportantStyles            | 1     | 1.1%       | 1W                    |
| suspicious/noGlobalAssign               | 1     | 1.1%       | 1W                    |
| suspicious/useIterableCallbackReturn    | 1     | 1.1%       | 1W                    |
| correctness/useHookAtTopLevel           | 1     | 1.1%       | 1W                    |

## Files with Most Issues

| File                                                          | Type Errors | Deno Lint | Biome | Total |
| ------------------------------------------------------------- | ----------- | --------- | ----- | ----- |
| packages/client/src/client.ts                                 | 23          | 0         | 0     | 23    |
| apps/atlasd/routes/streams/emit.ts                            | 21          | 0         | 0     | 21    |
| src/cli/commands/library/stats.tsx                            | 18          | 0         | 1     | 19    |
| src/cli/modules/messages/message-buffer.tsx                   | 15          | 0         | 4     | 19    |
| src/cli/utils/conversation-client.ts                          | 14          | 2         | 2     | 18    |
| src/cli/utils/daemon-client.ts                                | 18          | 0         | 0     | 18    |
| apps/web-client/src/lib/modules/client/conversation.ts        | 12          | 1         | 2     | 15    |
| src/cli/commands/workspace/status.tsx                         | 13          | 0         | 0     | 13    |
| packages/system/agents/conversation/conversation.agent.ts     | 7           | 2         | 3     | 12    |
| src/cli/commands/library/list.tsx                             | 12          | 0         | 0     | 12    |
| src/cli/commands/workspace/add.tsx                            | 0           | 0         | 11    | 11    |
| src/core/storage/memory-kv-storage.ts                         | 2           | 8         | 0     | 10    |
| packages/core/src/agent-server/server.ts                      | 8           | 0         | 1     | 9     |
| packages/core/src/orchestrator/agent-orchestrator.ts          | 9           | 0         | 0     | 9     |
| packages/core/src/library/types.ts                            | 4           | 0         | 4     | 8     |
| tools/evals/agents/slack-communicator/message-posting.eval.ts | 8           | 0         | 0     | 8     |
| packages/notifications/src/notification-manager.ts            | 7           | 0         | 0     | 7     |
| src/cli/commands/agent/describe.tsx                           | 3           | 0         | 4     | 7     |
| src/cli/commands/workspace/list.tsx                           | 5           | 0         | 2     | 7     |
| src/core/providers/registry.ts                                | 6           | 1         | 0     | 7     |
| ... and 94 more files                                         |             |           |       |       |

## Issues by Project

| Project                 | Type Errors | Deno Lint | Biome | Total |
| ----------------------- | ----------- | --------- | ----- | ----- |
| src                     | 153         | 15        | 52    | 220   |
| packages/core           | 45          | 2         | 13    | 60    |
| apps/atlasd             | 40          | 0         | 2     | 42    |
| packages/client         | 26          | 0         | 0     | 26    |
| apps/web-client         | 19          | 1         | 3     | 23    |
| tools/evals             | 18          | 0         | 0     | 18    |
| packages/mcp-server     | 14          | 0         | 0     | 14    |
| other                   | 11          | 0         | 2     | 13    |
| packages/system         | 7           | 2         | 3     | 12    |
| packages/notifications  | 9           | 0         | 0     | 9     |
| tools/atlas-installer   | 0           | 0         | 9     | 9     |
| packages/mcp            | 4           | 0         | 1     | 5     |
| packages/vendor         | 0           | 4         | 1     | 5     |
| packages/agent-sdk      | 4           | 0         | 0     | 4     |
| packages/openapi-client | 1           | 0         | 1     | 2     |
| packages/utils          | 1           | 0         | 0     | 1     |
| packages/workspace      | 1           | 0         | 0     | 1     |

## Workspace Dependency Graph

### Dependency Analysis

| Package                 | Dependencies                                                                                  | Dependents                                                                                                                         | Complexity Score |
| ----------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| utils                   | none                                                                                          | web-client, atlasd, core, logger, memory, config, signals, mcp-server, bundled-agents, storage, system, diagnostics, client, evals | 28               |
| logger                  | utils                                                                                         | atlasd, agent-sdk, core, memory, signals, workspace, mcp, bundled-agents, system, fs-watch, diagnostics, notifications             | 25               |
| core                    | config, logger, mcp, utils, agent-sdk, bundled-agents, oapi-client, memory                    | web-client, atlasd, agent-sdk, mcp-server, bundled-agents, system, client, evals                                                   | 24               |
| atlasd                  | core, logger, utils, config, workspace, storage, agent-sdk, cron, mcp-server, memory, signals | mcp-server, mcp, client, openapi-client, evals                                                                                     | 21               |
| config                  | utils, agent-sdk, storage                                                                     | atlasd, core, workspace, mcp-server, system, notifications                                                                         | 15               |
| agent-sdk               | logger, core                                                                                  | atlasd, core, config, bundled-agents, system, evals                                                                                | 14               |
| memory                  | storage, logger, utils                                                                        | atlasd, core, storage, system, memory_manager                                                                                      | 13               |
| workspace               | config, logger, storage, system, fs-watch                                                     | atlasd, diagnostics, cron, memory_manager                                                                                          | 13               |
| system                  | agent-sdk, client, core, utils, config, bundled-agents, logger, memory, oapi-client           | workspace, evals                                                                                                                   | 13               |
| client                  | utils, atlasd, core                                                                           | web-client, mcp-server, system, diagnostics, evals                                                                                 | 13               |
| bundled-agents          | core, agent-sdk, logger, utils                                                                | core, system, evals                                                                                                                | 10               |
| storage                 | memory, utils                                                                                 | atlasd, memory, config, workspace                                                                                                  | 10               |
| mcp-server              | client, utils, core, oapi-client, notifications, config, atlasd                               | atlasd                                                                                                                             | 9                |
| evals                   | bundled-agents, client, core, system, oapi-client, agent-sdk, atlasd, utils                   | none                                                                                                                               | 8                |
| web-client              | core, client, oapi-client, utils                                                              | none                                                                                                                               | 4                |
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
   - web-client (19 errors)
   - openapi-client (1 errors)
   - evals (18 errors)

2. **Then fix middle-tier packages** (1-3 dependents):
   - mcp-server (14 errors, 1 dependents)
   - mcp (4 errors, 1 dependents)
   - system (7 errors, 2 dependents)
   - notifications (9 errors, 1 dependents)

3. **Finally, fix core packages** (many packages depend on these):
   - atlasd (40 errors, 5 dependents)
   - agent-sdk (4 errors, 6 dependents)
   - core (45 errors, 8 dependents)
   - workspace (1 errors, 4 dependents)
   - utils (1 errors, 14 dependents)
   - client (26 errors, 5 dependents)

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

- **[Type] TS2339**: "Property 'toolCalls' does not exist on type 'Resul..."
  - Occurrences: 9
  - Files affected: 6

- **[Type] TS2339**: "Property 'toolResults' does not exist on type 'Res..."
  - Occurrences: 9
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

- **[Type] TS2339**: "Property 'error' does not exist on type 'never'...."
  - Occurrences: 6
  - Files affected: 3

- **[Type] TS2532**: "Object is possibly 'undefined'...."
  - Occurrences: 5
  - Files affected: 3

- **[Type] TS2345**: "Argument of type '"/api/workspaces/{workspaceId}/s..."
  - Occurrences: 5
  - Files affected: 3

- **[Type] TS2339**: "Property 'message' does not exist on type 'never'...."
  - Occurrences: 5
  - Files affected: 3

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

### High-Impact Files

Files with issues from multiple tools (need attention):

| File                                                      | Type Errors | Deno Lint | Biome | Total |
| --------------------------------------------------------- | ----------- | --------- | ----- | ----- |
| src/cli/commands/library/stats.tsx                        | 18          | 0         | 1     | 19    |
| src/cli/modules/messages/message-buffer.tsx               | 15          | 0         | 4     | 19    |
| src/cli/utils/conversation-client.ts                      | 14          | 2         | 2     | 18    |
| apps/web-client/src/lib/modules/client/conversation.ts    | 12          | 1         | 2     | 15    |
| packages/system/agents/conversation/conversation.agent.ts | 7           | 2         | 3     | 12    |
| src/core/storage/memory-kv-storage.ts                     | 2           | 8         | 0     | 10    |
| packages/core/src/agent-server/server.ts                  | 8           | 0         | 1     | 9     |
| packages/core/src/library/types.ts                        | 4           | 0         | 4     | 8     |
| src/cli/commands/agent/describe.tsx                       | 3           | 0         | 4     | 7     |
| src/cli/commands/workspace/list.tsx                       | 5           | 0         | 2     | 7     |
