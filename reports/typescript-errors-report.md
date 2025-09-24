# TypeScript & Lint Analysis Report

**Generated:** 2025-09-24T04:15:26.817Z

**Total Issues:** 1180 (665 type errors, 149 deno lint violations, 366 biome
violations)

## Summary Statistics

### TypeScript Errors

- **Total errors:** 665
- **Unique error types:** 32
- **Files with errors:** 153

### Deno Lint Violations

- **Total violations:** 149
- **Unique rules violated:** 4
- **Files with violations:** 63

### Biome Violations

- **Total violations:** 366
- **Errors:** 1
- **Warnings:** 365
- **Unique rules violated:** 28
- **Files with violations:** 133

## TypeScript Error Types Breakdown

| Error Code | Count | Percentage | Description                                  |
| ---------- | ----- | ---------- | -------------------------------------------- |
| TS2339     | 155   | 23.3%      | Property does not exist on type              |
| TS18046    | 134   | 20.2%      | Value is of type 'unknown'                   |
| TS2322     | 95    | 14.3%      | Type not assignable                          |
| TS2345     | 51    | 7.7%       | Argument type not assignable                 |
| TS6133     | 51    | 7.7%       | Variable declared but never used             |
| TS6196     | 40    | 6.0%       | Catch clause variable unused                 |
| TS2532     | 23    | 3.5%       | Object is possibly 'undefined'               |
| TS7053     | 22    | 3.3%       | Element implicitly has any type              |
| TS18048    | 18    | 2.7%       | Value is possibly 'undefined'                |
| TS2305     | 10    | 1.5%       | Module has no exported member                |
| TS2694     | 9     | 1.4%       | Namespace has no exported member             |
| TS2769     | 8     | 1.2%       | No overload matches call                     |
| TS7006     | 7     | 1.1%       | Parameter implicitly has any type            |
| TS2698     | 6     | 0.9%       | Spread types may only be object types        |
| TS2571     | 6     | 0.9%       | Object is of type 'unknown'                  |
| TS2724     | 6     | 0.9%       | Module has no default export                 |
| TS2459     | 4     | 0.6%       | TypeScript error                             |
| TS2739     | 2     | 0.3%       | Type is missing properties                   |
| TS2416     | 2     | 0.3%       | Property type not assignable to base         |
| TS2540     | 2     | 0.3%       | Cannot assign to read-only property          |
| TS2578     | 2     | 0.3%       | Unused ts-expect-error directive             |
| TS4104     | 2     | 0.3%       | Parameter property readonly/mutable conflict |
| TS2741     | 1     | 0.2%       | Property is missing in type                  |
| TS2304     | 1     | 0.2%       | Cannot find name                             |
| TS6138     | 1     | 0.2%       | Property declared but never used             |
| TS2554     | 1     | 0.2%       | Argument count mismatch                      |
| TS2353     | 1     | 0.2%       | Object literal has unknown properties        |
| TS2559     | 1     | 0.2%       | Type has no common properties                |
| TS2740     | 1     | 0.2%       | Type is missing index signature              |
| TS18004    | 1     | 0.2%       | TypeScript error                             |
| TS2307     | 1     | 0.2%       | Cannot find module                           |
| TS7017     | 1     | 0.2%       | Type has no index signature                  |

## Deno Lint Rules Breakdown

| Rule Name       | Count | Percentage | Description                      |
| --------------- | ----- | ---------- | -------------------------------- |
| require-await   | 84    | 56.4%      | Async function without await     |
| no-unused-vars  | 57    | 38.3%      | Variable declared but never used |
| no-empty        | 4     | 2.7%       | Empty block statement            |
| no-explicit-any | 4     | 2.7%       | Explicit 'any' type usage        |

## Biome Rules Breakdown

| Rule Name                               | Count | Percentage | Severity Distribution |
| --------------------------------------- | ----- | ---------- | --------------------- |
| style/noNonNullAssertion                | 82    | 22.4%      | 82W                   |
| correctness/noUnusedVariables           | 79    | 21.6%      | 79W                   |
| style/useTemplate                       | 72    | 19.7%      | 72W                   |
| correctness/useExhaustiveDependencies   | 24    | 6.6%       | 24W                   |
| complexity/useLiteralKeys               | 13    | 3.6%       | 13W                   |
| complexity/useOptionalChain             | 13    | 3.6%       | 13W                   |
| correctness/noUnusedImports             | 12    | 3.3%       | 12W                   |
| suspicious/noExplicitAny                | 12    | 3.3%       | 12W                   |
| suspicious/noImplicitAnyLet             | 8     | 2.2%       | 8W                    |
| suspicious/noArrayIndexKey              | 8     | 2.2%       | 8W                    |
| complexity/noStaticOnlyClass            | 7     | 1.9%       | 7W                    |
| suspicious/useBiomeIgnoreFolder         | 6     | 1.6%       | 6W                    |
| style/useImportType                     | 4     | 1.1%       | 4W                    |
| suspicious/useIterableCallbackReturn    | 4     | 1.1%       | 1E/3W                 |
| correctness/useParseIntRadix            | 3     | 0.8%       | 3W                    |
| correctness/noUnusedPrivateClassMembers | 3     | 0.8%       | 3W                    |
| correctness/noUnusedFunctionParameters  | 3     | 0.8%       | 3W                    |
| suspicious/noEmptyBlock                 | 2     | 0.5%       | 2W                    |
| suspicious/noAssignInExpressions        | 2     | 0.5%       | 2W                    |
| complexity/noUselessConstructor         | 1     | 0.3%       | 1W                    |
| complexity/noUselessCatch               | 1     | 0.3%       | 1W                    |
| complexity/noUselessFragments           | 1     | 0.3%       | 1W                    |
| complexity/noUselessTernary             | 1     | 0.3%       | 1W                    |
| complexity/noUselessSwitchCase          | 1     | 0.3%       | 1W                    |
| suspicious/noConfusingVoidType          | 1     | 0.3%       | 1W                    |
| suspicious/noIrregularWhitespace        | 1     | 0.3%       | 1W                    |
| complexity/noImportantStyles            | 1     | 0.3%       | 1W                    |
| correctness/useHookAtTopLevel           | 1     | 0.3%       | 1W                    |

## Files with Most Issues

| File                                                            | Type Errors | Deno Lint | Biome | Total |
| --------------------------------------------------------------- | ----------- | --------- | ----- | ----- |
| src/cli/modules/sessions/fetcher.test.ts                        | 57          | 18        | 0     | 75    |
| tools/memory_manager/src/tui.ts                                 | 8           | 9         | 26    | 43    |
| src/core/manager.ts                                             | 23          | 1         | 1     | 25    |
| packages/client/src/client.ts                                   | 23          | 0         | 1     | 24    |
| src/cli/utils/daemon-client.ts                                  | 22          | 1         | 1     | 24    |
| src/cli/utils/prompts.tsx                                       | 5           | 11        | 8     | 24    |
| packages/cron/tests/timer-signal-workspace-integration.test.ts  | 0           | 0         | 21    | 21    |
| src/cli/commands/library/stats.tsx                              | 18          | 0         | 1     | 19    |
| src/core/actors/session-supervisor-actor.ts                     | 11          | 0         | 8     | 19    |
| apps/atlasd/src/atlas-daemon.ts                                 | 18          | 0         | 0     | 18    |
| packages/mcp-server/src/tools/utils.ts                          | 18          | 0         | 0     | 18    |
| src/cli/modules/messages/message-buffer.tsx                     | 12          | 1         | 5     | 18    |
| src/cli/utils/conversation-client.ts                            | 12          | 3         | 3     | 18    |
| tools/memory_manager/main.ts                                    | 17          | 0         | 1     | 18    |
| packages/storage/tests/memory/coala-local.test.ts               | 16          | 0         | 1     | 17    |
| src/utils/diagnostics-collector.ts                              | 11          | 0         | 6     | 17    |
| apps/atlasd/routes/workspaces/schemas.ts                        | 8           | 0         | 8     | 16    |
| src/cli/modules/input/tests/file-path-detector-extended.test.ts | 0           | 0         | 14    | 14    |
| src/core/storage/memory-kv-storage.ts                           | 3           | 9         | 1     | 13    |
| src/core/workspace-runtime-machine.ts                           | 9           | 1         | 3     | 13    |
| ... and 197 more files                                          |             |           |       |       |

## Issues by Project

| Project                 | Type Errors | Deno Lint | Biome | Total |
| ----------------------- | ----------- | --------- | ----- | ----- |
| src                     | 312         | 77        | 172   | 561   |
| apps/atlasd             | 57          | 3         | 26    | 86    |
| packages/core           | 54          | 5         | 14    | 73    |
| tools/memory_manager    | 27          | 11        | 29    | 67    |
| packages/storage        | 39          | 6         | 12    | 57    |
| packages/cron           | 12          | 0         | 43    | 55    |
| packages/mcp-server     | 49          | 2         | 2     | 53    |
| packages/memory         | 0           | 29        | 16    | 45    |
| packages/signals        | 22          | 6         | 7     | 35    |
| packages/client         | 26          | 1         | 4     | 31    |
| other                   | 14          | 4         | 10    | 28    |
| apps/web-client         | 15          | 3         | 4     | 22    |
| tools/atlas-installer   | 0           | 0         | 19    | 19    |
| packages/system         | 13          | 0         | 1     | 14    |
| tools/evals             | 9           | 2         | 2     | 13    |
| packages/notifications  | 8           | 0         | 0     | 8     |
| packages/mcp            | 3           | 0         | 3     | 6     |
| packages/openapi-client | 1           | 0         | 2     | 3     |
| packages/agent-sdk      | 2           | 0         | 0     | 2     |
| packages/workspace      | 1           | 0         | 0     | 1     |
| packages/bundled-agents | 1           | 0         | 0     | 1     |

## Workspace Dependency Graph

### Dependency Analysis

| Package                 | Dependencies                                                                  | Dependents                                                                                                                                | Complexity Score |
| ----------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| logger                  | utils                                                                         | diagnostics, atlasd, agent-sdk, core, memory, signals, workspace, mcp-server, mcp, bundled-agents, system, fs-watch, notifications, evals | 29               |
| atlasd                  | logger, core, utils, config, workspace, storage, cron, mcp-server, memory     | mcp-server, mcp, client, openapi-client, evals                                                                                            | 19               |
| utils                   | none                                                                          | diagnostics, atlasd, logger, memory, config, storage, system, client, evals                                                               | 18               |
| core                    | config, logger, mcp, agent-sdk, bundled-agents, oapi-client, memory           | web-client, atlasd, client, evals                                                                                                         | 15               |
| config                  | utils, agent-sdk, storage                                                     | atlasd, core, workspace, mcp-server, system, notifications                                                                                | 15               |
| memory                  | storage, logger, utils                                                        | atlasd, core, storage, system, memory_manager                                                                                             | 13               |
| workspace               | config, logger, storage, system, fs-watch                                     | diagnostics, atlasd, cron, memory_manager                                                                                                 | 13               |
| system                  | logger, config, agent-sdk, bundled-agents, utils, oapi-client, memory, client | workspace, evals                                                                                                                          | 12               |
| agent-sdk               | logger                                                                        | core, config, bundled-agents, system, evals                                                                                               | 11               |
| storage                 | memory, utils                                                                 | atlasd, memory, config, workspace                                                                                                         | 10               |
| client                  | atlasd, utils, core                                                           | diagnostics, web-client, system                                                                                                           | 9                |
| bundled-agents          | agent-sdk, logger                                                             | core, system, evals                                                                                                                       | 8                |
| evals                   | system, oapi-client, bundled-agents, agent-sdk, logger, atlasd, core, utils   | none                                                                                                                                      | 8                |
| mcp-server              | oapi-client, logger, notifications, config, atlasd                            | atlasd                                                                                                                                    | 7                |
| diagnostics             | client, logger, utils, workspace                                              | none                                                                                                                                      | 4                |
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
   - signals (22 errors)
   - openapi-client (1 errors)
   - memory_manager (27 errors)
   - evals (9 errors)

2. **Then fix middle-tier packages** (1-3 dependents):
   - mcp-server (49 errors, 1 dependents)
   - mcp (3 errors, 1 dependents)
   - bundled-agents (1 errors, 3 dependents)
   - system (13 errors, 2 dependents)
   - client (26 errors, 3 dependents)
   - notifications (8 errors, 1 dependents)
   - cron (12 errors, 1 dependents)

3. **Finally, fix core packages** (many packages depend on these):
   - atlasd (57 errors, 5 dependents)
   - agent-sdk (2 errors, 5 dependents)
   - core (54 errors, 4 dependents)
   - workspace (1 errors, 4 dependents)
   - storage (39 errors, 4 dependents)

## Code Quality Hotspots Analysis

### Most Common Issue Patterns

Issues that appear across multiple files (potential systematic problems):

- **[Biome] style/noNonNullAssertion**: "Unsafe fix..."
  - Occurrences: 82
  - Files affected: 15

- **[Biome] correctness/noUnusedVariables**: "Unused variables are often the
  result of an incomp..."
  - Occurrences: 79
  - Files affected: 46

- **[Biome] style/useTemplate**: "Template literals are preferred over string
  concat..."
  - Occurrences: 72
  - Files affected: 31

- **[Deno Lint] require-await**: "Async arrow function has no 'await' expression
  or ..."
  - Occurrences: 24
  - Files affected: 3

- **[Type] TS2532**: "Object is possibly 'undefined'...."
  - Occurrences: 23
  - Files affected: 3

- **[Type] TS7053**: "Element implicitly has an 'any' type because expre..."
  - Occurrences: 22
  - Files affected: 9

- **[Type] TS2345**: "Argument of type 'unknown' is not assignable to pa..."
  - Occurrences: 18
  - Files affected: 10

- **[Biome] complexity/useLiteralKeys**: "The computed expression can be
  simplified without ..."
  - Occurrences: 13
  - Files affected: 8

- **[Type] TS18046**: "'errorData' is of type 'unknown'...."
  - Occurrences: 12
  - Files affected: 9

- **[Biome] correctness/noUnusedImports**: "Unused imports might be the result
  of an incomplet..."
  - Occurrences: 12
  - Files affected: 12

- **[Biome] suspicious/noExplicitAny**: "any disables many type checking rules.
  Its use sho..."
  - Occurrences: 12
  - Files affected: 4

- **[Type] TS18046**: "'config' is of type 'unknown'...."
  - Occurrences: 11
  - Files affected: 3

- **[Type] TS2305**: "Module '"file..."
  - Occurrences: 10
  - Files affected: 7

- **[Type] TS2769**: "No overload matches this call...."
  - Occurrences: 8
  - Files affected: 6

- **[Biome] suspicious/noImplicitAnyLet**: "This variable implicitly has the any
  type. Variabl..."
  - Occurrences: 8
  - Files affected: 8

### High-Impact Files

Files with issues from multiple tools (need attention):

| File                                        | Type Errors | Deno Lint | Biome | Total |
| ------------------------------------------- | ----------- | --------- | ----- | ----- |
| src/cli/modules/sessions/fetcher.test.ts    | 57          | 18        | 0     | 75    |
| tools/memory_manager/src/tui.ts             | 8           | 9         | 26    | 43    |
| src/core/manager.ts                         | 23          | 1         | 1     | 25    |
| packages/client/src/client.ts               | 23          | 0         | 1     | 24    |
| src/cli/utils/daemon-client.ts              | 22          | 1         | 1     | 24    |
| src/cli/utils/prompts.tsx                   | 5           | 11        | 8     | 24    |
| src/cli/commands/library/stats.tsx          | 18          | 0         | 1     | 19    |
| src/core/actors/session-supervisor-actor.ts | 11          | 0         | 8     | 19    |
| src/cli/modules/messages/message-buffer.tsx | 12          | 1         | 5     | 18    |
| src/cli/utils/conversation-client.ts        | 12          | 3         | 3     | 18    |
