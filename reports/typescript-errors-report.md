# TypeScript & Lint Analysis Report

**Generated:** 2025-10-04T01:44:47.207Z

**Total Issues:** 389 (305 type errors, 22 deno lint violations, 62 biome
violations)

## Summary Statistics

### TypeScript Errors

- **Total errors:** 305
- **Unique error types:** 24
- **Files with errors:** 76

### Deno Lint Violations

- **Total violations:** 22
- **Unique rules violated:** 5
- **Files with violations:** 10

### Biome Violations

- **Total violations:** 62
- **Errors:** 1
- **Warnings:** 61
- **Unique rules violated:** 22
- **Files with violations:** 40

## TypeScript Error Types Breakdown

| Error Code | Count | Percentage | Description                                  |
| ---------- | ----- | ---------- | -------------------------------------------- |
| TS2339     | 104   | 34.1%      | Property does not exist on type              |
| TS2322     | 59    | 19.3%      | Type not assignable                          |
| TS2345     | 40    | 13.1%      | Argument type not assignable                 |
| TS18046    | 34    | 11.1%      | Value is of type 'unknown'                   |
| TS18048    | 16    | 5.2%       | Value is possibly 'undefined'                |
| TS7006     | 7     | 2.3%       | Parameter implicitly has any type            |
| TS6196     | 7     | 2.3%       | Catch clause variable unused                 |
| TS2531     | 6     | 2.0%       | Object is possibly 'null'                    |
| TS2694     | 6     | 2.0%       | Namespace has no exported member             |
| TS2532     | 5     | 1.6%       | Object is possibly 'undefined'               |
| TS2305     | 3     | 1.0%       | Module has no exported member                |
| TS6133     | 2     | 0.7%       | Variable declared but never used             |
| TS2769     | 2     | 0.7%       | No overload matches call                     |
| TS2739     | 2     | 0.7%       | Type is missing properties                   |
| TS2578     | 2     | 0.7%       | Unused ts-expect-error directive             |
| TS4104     | 2     | 0.7%       | Parameter property readonly/mutable conflict |
| TS2741     | 1     | 0.3%       | Property is missing in type                  |
| TS2538     | 1     | 0.3%       | TypeScript error                             |
| TS2367     | 1     | 0.3%       | TypeScript error                             |
| TS2554     | 1     | 0.3%       | Argument count mismatch                      |
| TS6192     | 1     | 0.3%       | TypeScript error                             |
| TS7053     | 1     | 0.3%       | Element implicitly has any type              |
| TS2740     | 1     | 0.3%       | Type is missing index signature              |
| TS7017     | 1     | 0.3%       | Type has no index signature                  |

## Deno Lint Rules Breakdown

| Rule Name        | Count | Percentage | Description                      |
| ---------------- | ----- | ---------- | -------------------------------- |
| require-await    | 15    | 68.2%      | Async function without await     |
| no-explicit-any  | 2     | 9.1%       | Explicit 'any' type usage        |
| no-fallthrough   | 2     | 9.1%       | Case statement fallthrough       |
| no-unused-vars   | 2     | 9.1%       | Variable declared but never used |
| no-global-assign | 1     | 4.5%       | Global variable assignment       |

## Biome Rules Breakdown

| Rule Name                               | Count | Percentage | Severity Distribution |
| --------------------------------------- | ----- | ---------- | --------------------- |
| style/useTemplate                       | 12    | 19.4%      | 12W                   |
| correctness/useExhaustiveDependencies   | 9     | 14.5%      | 1E/8W                 |
| correctness/noUnusedVariables           | 8     | 12.9%      | 8W                    |
| complexity/noStaticOnlyClass            | 5     | 8.1%       | 5W                    |
| complexity/useOptionalChain             | 5     | 8.1%       | 5W                    |
| correctness/useParseIntRadix            | 2     | 3.2%       | 2W                    |
| correctness/noUnusedPrivateClassMembers | 2     | 3.2%       | 2W                    |
| suspicious/noEmptyBlock                 | 2     | 3.2%       | 2W                    |
| suspicious/noExplicitAny                | 2     | 3.2%       | 2W                    |
| suspicious/noAssignInExpressions        | 2     | 3.2%       | 2W                    |
| suspicious/noFallthroughSwitchClause    | 2     | 3.2%       | 2W                    |
| complexity/noUselessSwitchCase          | 1     | 1.6%       | 1W                    |
| complexity/useLiteralKeys               | 1     | 1.6%       | 1W                    |
| suspicious/useBiomeIgnoreFolder         | 1     | 1.6%       | 1W                    |
| suspicious/noConfusingVoidType          | 1     | 1.6%       | 1W                    |
| style/noNonNullAssertion                | 1     | 1.6%       | 1W                    |
| correctness/noUnusedImports             | 1     | 1.6%       | 1W                    |
| suspicious/noIrregularWhitespace        | 1     | 1.6%       | 1W                    |
| complexity/noImportantStyles            | 1     | 1.6%       | 1W                    |
| suspicious/noGlobalAssign               | 1     | 1.6%       | 1W                    |
| suspicious/useIterableCallbackReturn    | 1     | 1.6%       | 1W                    |
| correctness/useHookAtTopLevel           | 1     | 1.6%       | 1W                    |

## Files with Most Issues

| File                                                          | Type Errors | Deno Lint | Biome | Total |
| ------------------------------------------------------------- | ----------- | --------- | ----- | ----- |
| packages/client/src/client.ts                                 | 23          | 0         | 0     | 23    |
| src/cli/utils/daemon-client.ts                                | 19          | 2         | 1     | 22    |
| apps/atlasd/routes/streams/emit.ts                            | 21          | 0         | 0     | 21    |
| src/cli/modules/messages/message-buffer.tsx                   | 15          | 0         | 4     | 19    |
| src/cli/utils/conversation-client.ts                          | 14          | 2         | 2     | 18    |
| apps/web-client/src/lib/modules/client/conversation.ts        | 12          | 1         | 2     | 15    |
| src/cli/commands/library/list.tsx                             | 12          | 0         | 0     | 12    |
| packages/system/agents/conversation/conversation.agent.ts     | 6           | 2         | 3     | 11    |
| src/core/storage/memory-kv-storage.ts                         | 2           | 8         | 0     | 10    |
| packages/core/src/agent-server/server.ts                      | 8           | 0         | 1     | 9     |
| packages/core/src/orchestrator/agent-orchestrator.ts          | 9           | 0         | 0     | 9     |
| packages/core/src/library/types.ts                            | 4           | 0         | 4     | 8     |
| tools/evals/agents/slack-communicator/message-posting.eval.ts | 8           | 0         | 0     | 8     |
| packages/notifications/src/notification-manager.ts            | 7           | 0         | 0     | 7     |
| src/core/providers/registry.ts                                | 6           | 1         | 0     | 7     |
| src/core/workspace-runtime-machine.ts                         | 7           | 0         | 0     | 7     |
| apps/atlasd/routes/library/list.ts                            | 4           | 0         | 2     | 6     |
| packages/core/src/agent-server/in-memory-registry.ts          | 6           | 0         | 0     | 6     |
| packages/core/src/mcp-registry/web-discovery.ts               | 2           | 1         | 3     | 6     |
| src/cli/utils/prompts.tsx                                     | 1           | 3         | 2     | 6     |
| ... and 80 more files                                         |             |           |       |       |

## Issues by Project

| Project                 | Type Errors | Deno Lint | Biome | Total |
| ----------------------- | ----------- | --------- | ----- | ----- |
| src                     | 110         | 17        | 28    | 155   |
| packages/core           | 45          | 2         | 13    | 60    |
| apps/atlasd             | 39          | 0         | 2     | 41    |
| packages/client         | 26          | 0         | 0     | 26    |
| apps/web-client         | 19          | 1         | 3     | 23    |
| tools/evals             | 18          | 0         | 0     | 18    |
| packages/mcp-server     | 15          | 0         | 0     | 15    |
| other                   | 8           | 0         | 3     | 11    |
| packages/system         | 6           | 2         | 3     | 11    |
| packages/notifications  | 9           | 0         | 0     | 9     |
| tools/atlas-installer   | 0           | 0         | 8     | 8     |
| packages/mcp            | 4           | 0         | 1     | 5     |
| packages/agent-sdk      | 4           | 0         | 0     | 4     |
| packages/openapi-client | 1           | 0         | 1     | 2     |
| packages/workspace      | 1           | 0         | 0     | 1     |

## Workspace Dependency Graph

### Dependency Analysis

| Package                 | Dependencies                                                                                  | Dependents                                                                                                                         | Complexity Score |
| ----------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| utils                   | none                                                                                          | web-client, atlasd, core, logger, memory, config, signals, mcp-server, bundled-agents, storage, system, diagnostics, client, evals | 28               |
| logger                  | utils                                                                                         | atlasd, agent-sdk, core, memory, signals, workspace, mcp, bundled-agents, system, fs-watch, diagnostics, notifications             | 25               |
| core                    | config, logger, mcp, utils, agent-sdk, bundled-agents, oapi-client, memory                    | web-client, atlasd, agent-sdk, mcp-server, bundled-agents, system, client, evals                                                   | 24               |
| atlasd                  | core, logger, utils, config, storage, agent-sdk, cron, mcp-server, memory, workspace, signals | mcp-server, mcp, client, openapi-client, evals                                                                                     | 21               |
| config                  | utils, agent-sdk, storage                                                                     | atlasd, core, workspace, mcp-server, system, notifications                                                                         | 15               |
| agent-sdk               | logger, core                                                                                  | atlasd, core, config, bundled-agents, system, evals                                                                                | 14               |
| memory                  | storage, logger, utils                                                                        | atlasd, core, storage, system, memory_manager                                                                                      | 13               |
| workspace               | config, logger, storage, system, fs-watch                                                     | atlasd, diagnostics, cron, memory_manager                                                                                          | 13               |
| system                  | agent-sdk, client, core, utils, config, bundled-agents, logger, memory, oapi-client           | workspace, evals                                                                                                                   | 13               |
| client                  | utils, atlasd, core                                                                           | web-client, mcp-server, system, diagnostics, evals                                                                                 | 13               |
| bundled-agents          | agent-sdk, core, logger, utils                                                                | core, system, evals                                                                                                                | 10               |
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
   - mcp-server (15 errors, 1 dependents)
   - mcp (4 errors, 1 dependents)
   - system (6 errors, 2 dependents)
   - notifications (9 errors, 1 dependents)

3. **Finally, fix core packages** (many packages depend on these):
   - atlasd (39 errors, 5 dependents)
   - agent-sdk (4 errors, 6 dependents)
   - core (45 errors, 8 dependents)
   - workspace (1 errors, 4 dependents)
   - client (26 errors, 5 dependents)

## Code Quality Hotspots Analysis

### Most Common Issue Patterns

Issues that appear across multiple files (potential systematic problems):

- **[Biome] style/useTemplate**: "Template literals are preferred over string
  concat..."
  - Occurrences: 12
  - Files affected: 8

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

- **[Type] TS2322**: "Type 'unknown' is not assignable to type '{ id..."
  - Occurrences: 6
  - Files affected: 3

- **[Type] TS2339**: "Property 'capabilities' does not exist on type '{ ..."
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
| src/cli/utils/daemon-client.ts                            | 19          | 2         | 1     | 22    |
| src/cli/modules/messages/message-buffer.tsx               | 15          | 0         | 4     | 19    |
| src/cli/utils/conversation-client.ts                      | 14          | 2         | 2     | 18    |
| apps/web-client/src/lib/modules/client/conversation.ts    | 12          | 1         | 2     | 15    |
| packages/system/agents/conversation/conversation.agent.ts | 6           | 2         | 3     | 11    |
| src/core/storage/memory-kv-storage.ts                     | 2           | 8         | 0     | 10    |
| packages/core/src/agent-server/server.ts                  | 8           | 0         | 1     | 9     |
| packages/core/src/library/types.ts                        | 4           | 0         | 4     | 8     |
| src/core/providers/registry.ts                            | 6           | 1         | 0     | 7     |
| apps/atlasd/routes/library/list.ts                        | 4           | 0         | 2     | 6     |
