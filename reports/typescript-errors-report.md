# TypeScript & Lint Analysis Report

**Generated:** 2025-10-04T20:47:12.107Z

**Total Issues:** 323 (246 type errors, 20 deno lint violations, 57 biome
violations)

## Summary Statistics

### TypeScript Errors

- **Total errors:** 246
- **Unique error types:** 23
- **Files with errors:** 75

### Deno Lint Violations

- **Total violations:** 20
- **Unique rules violated:** 4
- **Files with violations:** 9

### Biome Violations

- **Total violations:** 57
- **Errors:** 3
- **Warnings:** 54
- **Unique rules violated:** 19
- **Files with violations:** 37

## TypeScript Error Types Breakdown

| Error Code | Count | Percentage | Description                                  |
| ---------- | ----- | ---------- | -------------------------------------------- |
| TS2339     | 89    | 36.2%      | Property does not exist on type              |
| TS2322     | 39    | 15.9%      | Type not assignable                          |
| TS2345     | 33    | 13.4%      | Argument type not assignable                 |
| TS18046    | 19    | 7.7%       | Value is of type 'unknown'                   |
| TS18048    | 16    | 6.5%       | Value is possibly 'undefined'                |
| TS7006     | 7     | 2.8%       | Parameter implicitly has any type            |
| TS6196     | 7     | 2.8%       | Catch clause variable unused                 |
| TS2531     | 6     | 2.4%       | Object is possibly 'null'                    |
| TS2694     | 6     | 2.4%       | Namespace has no exported member             |
| TS2305     | 5     | 2.0%       | Module has no exported member                |
| TS2532     | 3     | 1.2%       | Object is possibly 'undefined'               |
| TS2554     | 2     | 0.8%       | Argument count mismatch                      |
| TS2769     | 2     | 0.8%       | No overload matches call                     |
| TS2578     | 2     | 0.8%       | Unused ts-expect-error directive             |
| TS4104     | 2     | 0.8%       | Parameter property readonly/mutable conflict |
| TS6133     | 1     | 0.4%       | Variable declared but never used             |
| TS2741     | 1     | 0.4%       | Property is missing in type                  |
| TS2559     | 1     | 0.4%       | Type has no common properties                |
| TS2538     | 1     | 0.4%       | TypeScript error                             |
| TS2367     | 1     | 0.4%       | TypeScript error                             |
| TS7053     | 1     | 0.4%       | Element implicitly has any type              |
| TS2740     | 1     | 0.4%       | Type is missing index signature              |
| TS7017     | 1     | 0.4%       | Type has no index signature                  |

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
| style/useTemplate                       | 12    | 21.1%      | 12W                   |
| correctness/useExhaustiveDependencies   | 9     | 15.8%      | 1E/8W                 |
| correctness/noUnusedVariables           | 8     | 14.0%      | 8W                    |
| complexity/noStaticOnlyClass            | 5     | 8.8%       | 5W                    |
| complexity/useOptionalChain             | 5     | 8.8%       | 5W                    |
| suspicious/noEmptyBlock                 | 2     | 3.5%       | 2W                    |
| suspicious/noExplicitAny                | 2     | 3.5%       | 2W                    |
| suspicious/noAssignInExpressions        | 2     | 3.5%       | 2W                    |
| suspicious/noFallthroughSwitchClause    | 2     | 3.5%       | 2W                    |
| complexity/noUselessSwitchCase          | 1     | 1.8%       | 1W                    |
| complexity/useLiteralKeys               | 1     | 1.8%       | 1W                    |
| suspicious/noConfusingVoidType          | 1     | 1.8%       | 1W                    |
| correctness/noUnusedPrivateClassMembers | 1     | 1.8%       | 1W                    |
| style/noNonNullAssertion                | 1     | 1.8%       | 1W                    |
| suspicious/noIrregularWhitespace        | 1     | 1.8%       | 1W                    |
| complexity/noImportantStyles            | 1     | 1.8%       | 1E                    |
| suspicious/noGlobalAssign               | 1     | 1.8%       | 1W                    |
| suspicious/useIterableCallbackReturn    | 1     | 1.8%       | 1E                    |
| correctness/useHookAtTopLevel           | 1     | 1.8%       | 1W                    |

## Files with Most Issues

| File                                                          | Type Errors | Deno Lint | Biome | Total |
| ------------------------------------------------------------- | ----------- | --------- | ----- | ----- |
| apps/atlasd/routes/streams/emit.ts                            | 21          | 0         | 0     | 21    |
| src/cli/modules/messages/message-buffer.tsx                   | 15          | 0         | 4     | 19    |
| src/cli/utils/conversation-client.ts                          | 14          | 2         | 2     | 18    |
| apps/web-client/src/lib/modules/client/conversation.ts        | 10          | 1         | 1     | 12    |
| packages/system/agents/conversation/conversation.agent.ts     | 6           | 2         | 3     | 11    |
| src/core/storage/memory-kv-storage.ts                         | 2           | 8         | 0     | 10    |
| packages/core/src/agent-server/server.ts                      | 8           | 0         | 1     | 9     |
| packages/core/src/orchestrator/agent-orchestrator.ts          | 9           | 0         | 0     | 9     |
| packages/core/src/library/types.ts                            | 4           | 0         | 4     | 8     |
| tools/evals/agents/slack-communicator/message-posting.eval.ts | 8           | 0         | 0     | 8     |
| packages/notifications/src/notification-manager.ts            | 7           | 0         | 0     | 7     |
| src/core/providers/registry.ts                                | 6           | 1         | 0     | 7     |
| src/core/workspace-runtime-machine.ts                         | 7           | 0         | 0     | 7     |
| packages/core/src/agent-server/in-memory-registry.ts          | 6           | 0         | 0     | 6     |
| packages/core/src/mcp-registry/web-discovery.ts               | 2           | 1         | 3     | 6     |
| src/cli/utils/prompts.tsx                                     | 1           | 3         | 2     | 6     |
| src/core/storage/deno-kv-storage.ts                           | 6           | 0         | 0     | 6     |
| src/core/storage/index.ts                                     | 6           | 0         | 0     | 6     |
| packages/client/src/types/index.ts                            | 5           | 0         | 0     | 5     |
| packages/core/src/mcp-registry/agent-discovery.ts             | 4           | 0         | 1     | 5     |
| ... and 78 more files                                         |             |           |       |       |

## Issues by Project

| Project                 | Type Errors | Deno Lint | Biome | Total |
| ----------------------- | ----------- | --------- | ----- | ----- |
| src                     | 83          | 15        | 27    | 125   |
| packages/core           | 45          | 2         | 13    | 60    |
| apps/atlasd             | 30          | 0         | 0     | 30    |
| apps/web-client         | 16          | 1         | 2     | 19    |
| tools/evals             | 18          | 0         | 0     | 18    |
| packages/mcp-server     | 16          | 0         | 0     | 16    |
| packages/system         | 6           | 2         | 3     | 11    |
| packages/notifications  | 9           | 0         | 0     | 9     |
| other                   | 6           | 0         | 2     | 8     |
| tools/atlas-installer   | 0           | 0         | 8     | 8     |
| packages/client         | 7           | 0         | 0     | 7     |
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
| client                  | utils, atlasd, core, oapi-client                                                              | web-client, mcp-server, system, diagnostics, evals                                                                                 | 14               |
| memory                  | storage, logger, utils                                                                        | atlasd, core, storage, system, memory_manager                                                                                      | 13               |
| workspace               | config, logger, storage, system, fs-watch                                                     | atlasd, diagnostics, cron, memory_manager                                                                                          | 13               |
| system                  | agent-sdk, client, core, utils, config, bundled-agents, logger, memory, oapi-client           | workspace, evals                                                                                                                   | 13               |
| bundled-agents          | agent-sdk, core, logger, utils                                                                | core, system, evals                                                                                                                | 10               |
| storage                 | memory, utils                                                                                 | atlasd, memory, config, workspace                                                                                                  | 10               |
| mcp-server              | client, utils, core, oapi-client, notifications, config, atlasd                               | atlasd                                                                                                                             | 9                |
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
   - web-client (16 errors)
   - openapi-client (1 errors)
   - evals (18 errors)

2. **Then fix middle-tier packages** (1-3 dependents):
   - mcp-server (16 errors, 1 dependents)
   - mcp (4 errors, 1 dependents)
   - system (6 errors, 2 dependents)
   - notifications (9 errors, 1 dependents)

3. **Finally, fix core packages** (many packages depend on these):
   - atlasd (30 errors, 5 dependents)
   - agent-sdk (4 errors, 6 dependents)
   - core (45 errors, 8 dependents)
   - workspace (1 errors, 4 dependents)
   - client (7 errors, 5 dependents)

## Code Quality Hotspots Analysis

### Most Common Issue Patterns

Issues that appear across multiple files (potential systematic problems):

- **[Biome] style/useTemplate**: "Template literals are preferred over string
  concat..."
  - Occurrences: 12
  - Files affected: 8

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

- **[Type] TS2339**: "Property 'capabilities' does not exist on type '{ ..."
  - Occurrences: 6
  - Files affected: 3

- **[Type] TS2345**: "Argument of type 'string | undefined' is not assig..."
  - Occurrences: 6
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

### High-Impact Files

Files with issues from multiple tools (need attention):

| File                                                      | Type Errors | Deno Lint | Biome | Total |
| --------------------------------------------------------- | ----------- | --------- | ----- | ----- |
| src/cli/modules/messages/message-buffer.tsx               | 15          | 0         | 4     | 19    |
| src/cli/utils/conversation-client.ts                      | 14          | 2         | 2     | 18    |
| apps/web-client/src/lib/modules/client/conversation.ts    | 10          | 1         | 1     | 12    |
| packages/system/agents/conversation/conversation.agent.ts | 6           | 2         | 3     | 11    |
| src/core/storage/memory-kv-storage.ts                     | 2           | 8         | 0     | 10    |
| packages/core/src/agent-server/server.ts                  | 8           | 0         | 1     | 9     |
| packages/core/src/library/types.ts                        | 4           | 0         | 4     | 8     |
| src/core/providers/registry.ts                            | 6           | 1         | 0     | 7     |
| packages/core/src/mcp-registry/web-discovery.ts           | 2           | 1         | 3     | 6     |
| src/cli/utils/prompts.tsx                                 | 1           | 3         | 2     | 6     |
