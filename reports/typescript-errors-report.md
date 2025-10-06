# TypeScript & Lint Analysis Report

**Generated:** 2025-10-05T20:42:55.778Z

**Total Issues:** 256 (190 type errors, 15 deno lint violations, 51 biome
violations)

## Summary Statistics

### TypeScript Errors

- **Total errors:** 190
- **Unique error types:** 22
- **Files with errors:** 70

### Deno Lint Violations

- **Total violations:** 15
- **Unique rules violated:** 2
- **Files with violations:** 6

### Biome Violations

- **Total violations:** 51
- **Errors:** 1
- **Warnings:** 50
- **Unique rules violated:** 17
- **Files with violations:** 34

## TypeScript Error Types Breakdown

| Error Code | Count | Percentage | Description                                  |
| ---------- | ----- | ---------- | -------------------------------------------- |
| TS2339     | 79    | 41.6%      | Property does not exist on type              |
| TS2322     | 28    | 14.7%      | Type not assignable                          |
| TS2345     | 23    | 12.1%      | Argument type not assignable                 |
| TS18046    | 12    | 6.3%       | Value is of type 'unknown'                   |
| TS6196     | 7     | 3.7%       | Catch clause variable unused                 |
| TS7006     | 6     | 3.2%       | Parameter implicitly has any type            |
| TS2531     | 6     | 3.2%       | Object is possibly 'null'                    |
| TS2694     | 6     | 3.2%       | Namespace has no exported member             |
| TS2305     | 5     | 2.6%       | Module has no exported member                |
| TS2578     | 3     | 1.6%       | Unused ts-expect-error directive             |
| TS2554     | 2     | 1.1%       | Argument count mismatch                      |
| TS18048    | 2     | 1.1%       | Value is possibly 'undefined'                |
| TS4104     | 2     | 1.1%       | Parameter property readonly/mutable conflict |
| TS6133     | 1     | 0.5%       | Variable declared but never used             |
| TS2741     | 1     | 0.5%       | Property is missing in type                  |
| TS2559     | 1     | 0.5%       | Type has no common properties                |
| TS2538     | 1     | 0.5%       | TypeScript error                             |
| TS2532     | 1     | 0.5%       | Object is possibly 'undefined'               |
| TS2367     | 1     | 0.5%       | TypeScript error                             |
| TS7053     | 1     | 0.5%       | Element implicitly has any type              |
| TS2740     | 1     | 0.5%       | Type is missing index signature              |
| TS7017     | 1     | 0.5%       | Type has no index signature                  |

## Deno Lint Rules Breakdown

| Rule Name       | Count | Percentage | Description                  |
| --------------- | ----- | ---------- | ---------------------------- |
| require-await   | 14    | 93.3%      | Async function without await |
| no-explicit-any | 1     | 6.7%       | Explicit 'any' type usage    |

## Biome Rules Breakdown

| Rule Name                               | Count | Percentage | Severity Distribution |
| --------------------------------------- | ----- | ---------- | --------------------- |
| style/useTemplate                       | 12    | 23.5%      | 12W                   |
| correctness/useExhaustiveDependencies   | 9     | 17.6%      | 1E/8W                 |
| correctness/noUnusedVariables           | 8     | 15.7%      | 8W                    |
| complexity/noStaticOnlyClass            | 5     | 9.8%       | 5W                    |
| complexity/useOptionalChain             | 3     | 5.9%       | 3W                    |
| suspicious/noEmptyBlock                 | 2     | 3.9%       | 2W                    |
| suspicious/noAssignInExpressions        | 2     | 3.9%       | 2W                    |
| complexity/noUselessSwitchCase          | 1     | 2.0%       | 1W                    |
| complexity/useLiteralKeys               | 1     | 2.0%       | 1W                    |
| suspicious/noConfusingVoidType          | 1     | 2.0%       | 1W                    |
| correctness/noUnusedPrivateClassMembers | 1     | 2.0%       | 1W                    |
| style/noNonNullAssertion                | 1     | 2.0%       | 1W                    |
| suspicious/noExplicitAny                | 1     | 2.0%       | 1W                    |
| suspicious/noIrregularWhitespace        | 1     | 2.0%       | 1W                    |
| complexity/noImportantStyles            | 1     | 2.0%       | 1W                    |
| suspicious/useIterableCallbackReturn    | 1     | 2.0%       | 1W                    |
| correctness/useHookAtTopLevel           | 1     | 2.0%       | 1W                    |

## Files with Most Issues

| File                                                          | Type Errors | Deno Lint | Biome | Total |
| ------------------------------------------------------------- | ----------- | --------- | ----- | ----- |
| src/cli/modules/messages/message-buffer.tsx                   | 15          | 0         | 4     | 19    |
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
| packages/core/src/mcp-registry/unified-discovery.ts           | 4           | 0         | 1     | 5     |
| src/cli/modules/input/use-text-input-state.ts                 | 4           | 0         | 1     | 5     |
| apps/atlasd/routes/library/create.ts                          | 4           | 0         | 0     | 4     |
| apps/web-client/src/lib/modules/messages/format.ts            | 4           | 0         | 0     | 4     |
| ... and 73 more files                                         |             |           |       |       |

## Issues by Project

| Project                 | Type Errors | Deno Lint | Biome | Total |
| ----------------------- | ----------- | --------- | ----- | ----- |
| src                     | 69          | 13        | 25    | 107   |
| packages/core           | 45          | 2         | 13    | 60    |
| tools/evals             | 18          | 0         | 0     | 18    |
| packages/mcp-server     | 15          | 0         | 0     | 15    |
| packages/notifications  | 9           | 0         | 0     | 9     |
| other                   | 6           | 0         | 2     | 8     |
| apps/web-client         | 7           | 0         | 1     | 8     |
| tools/atlas-installer   | 0           | 0         | 8     | 8     |
| packages/client         | 7           | 0         | 0     | 7     |
| packages/mcp            | 4           | 0         | 1     | 5     |
| apps/atlasd             | 4           | 0         | 0     | 4     |
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
   - web-client (7 errors)
   - openapi-client (1 errors)
   - evals (18 errors)

2. **Then fix middle-tier packages** (1-3 dependents):
   - mcp-server (15 errors, 1 dependents)
   - mcp (4 errors, 1 dependents)
   - notifications (9 errors, 1 dependents)

3. **Finally, fix core packages** (many packages depend on these):
   - atlasd (4 errors, 5 dependents)
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

- **[Biome] complexity/noStaticOnlyClass**: "Prefer using simple functions
  instead of classes w..."
  - Occurrences: 5
  - Files affected: 4

- **[Type] TS2578**: "Unused '@ts-expect-error' directive...."
  - Occurrences: 3
  - Files affected: 3

### High-Impact Files

Files with issues from multiple tools (need attention):

| File                                                | Type Errors | Deno Lint | Biome | Total |
| --------------------------------------------------- | ----------- | --------- | ----- | ----- |
| src/cli/modules/messages/message-buffer.tsx         | 15          | 0         | 4     | 19    |
| src/core/storage/memory-kv-storage.ts               | 2           | 8         | 0     | 10    |
| packages/core/src/agent-server/server.ts            | 8           | 0         | 1     | 9     |
| packages/core/src/library/types.ts                  | 4           | 0         | 4     | 8     |
| src/core/providers/registry.ts                      | 6           | 1         | 0     | 7     |
| packages/core/src/mcp-registry/web-discovery.ts     | 2           | 1         | 3     | 6     |
| src/cli/utils/prompts.tsx                           | 1           | 3         | 2     | 6     |
| packages/core/src/mcp-registry/agent-discovery.ts   | 4           | 0         | 1     | 5     |
| packages/core/src/mcp-registry/unified-discovery.ts | 4           | 0         | 1     | 5     |
| src/cli/modules/input/use-text-input-state.ts       | 4           | 0         | 1     | 5     |
