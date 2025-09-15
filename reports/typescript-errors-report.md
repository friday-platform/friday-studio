# TypeScript & Lint Analysis Report

**Generated:** 2025-09-15T17:05:56.352Z

**Total Issues:** 2004 (1159 type errors, 312 deno lint violations, 533 biome
violations)

## Summary Statistics

### TypeScript Errors

- **Total errors:** 1159
- **Unique error types:** 35
- **Files with errors:** 224

### Deno Lint Violations

- **Total violations:** 312
- **Unique rules violated:** 6
- **Files with violations:** 102

### Biome Violations

- **Total violations:** 533
- **Errors:** 1
- **Warnings:** 532
- **Unique rules violated:** 29
- **Files with violations:** 187

## TypeScript Error Types Breakdown

| Error Code | Count | Percentage | Description                                  |
| ---------- | ----- | ---------- | -------------------------------------------- |
| TS18046    | 299   | 25.8%      | Value is of type 'unknown'                   |
| TS2339     | 243   | 21.0%      | Property does not exist on type              |
| TS2322     | 165   | 14.2%      | Type not assignable                          |
| TS6133     | 97    | 8.4%       | Variable declared but never used             |
| TS2345     | 84    | 7.2%       | Argument type not assignable                 |
| TS6196     | 56    | 4.8%       | Catch clause variable unused                 |
| TS7053     | 42    | 3.6%       | Element implicitly has any type              |
| TS2532     | 35    | 3.0%       | Object is possibly 'undefined'               |
| TS18048    | 25    | 2.2%       | Value is possibly 'undefined'                |
| TS2769     | 14    | 1.2%       | No overload matches call                     |
| TS7006     | 10    | 0.9%       | Parameter implicitly has any type            |
| TS2305     | 10    | 0.9%       | Module has no exported member                |
| TS2698     | 10    | 0.9%       | Spread types may only be object types        |
| TS2694     | 9     | 0.8%       | Namespace has no exported member             |
| TS2349     | 9     | 0.8%       | Cannot invoke expression                     |
| TS2724     | 8     | 0.7%       | Module has no default export                 |
| TS2571     | 6     | 0.5%       | Object is of type 'unknown'                  |
| TS2353     | 5     | 0.4%       | Object literal has unknown properties        |
| TS2459     | 5     | 0.4%       | TypeScript error                             |
| TS18047    | 5     | 0.4%       | Value is possibly 'null'                     |
| TS2741     | 3     | 0.3%       | Property is missing in type                  |
| TS2739     | 2     | 0.2%       | Type is missing properties                   |
| TS2416     | 2     | 0.2%       | Property type not assignable to base         |
| TS2540     | 2     | 0.2%       | Cannot assign to read-only property          |
| TS2578     | 2     | 0.2%       | Unused ts-expect-error directive             |
| TS4104     | 2     | 0.2%       | Parameter property readonly/mutable conflict |
| TS2638     | 1     | 0.1%       | Cannot augment module                        |
| TS2304     | 1     | 0.1%       | Cannot find name                             |
| TS2820     | 1     | 0.1%       | Type predicate incorrect                     |
| TS6138     | 1     | 0.1%       | Property declared but never used             |
| TS18050    | 1     | 0.1%       | Value is possibly null or undefined          |
| TS2554     | 1     | 0.1%       | Argument count mismatch                      |
| TS2559     | 1     | 0.1%       | Type has no common properties                |
| TS2740     | 1     | 0.1%       | Type is missing index signature              |
| TS7017     | 1     | 0.1%       | Type has no index signature                  |

## Deno Lint Rules Breakdown

| Rule Name         | Count | Percentage | Description                      |
| ----------------- | ----- | ---------- | -------------------------------- |
| no-unused-vars    | 131   | 42.0%      | Variable declared but never used |
| require-await     | 97    | 31.1%      | Async function without await     |
| no-process-global | 64    | 20.5%      | Lint rule violation              |
| no-explicit-any   | 11    | 3.5%       | Explicit 'any' type usage        |
| no-empty          | 8     | 2.6%       | Empty block statement            |
| no-control-regex  | 1     | 0.3%       | Control characters in regex      |

## Biome Rules Breakdown

| Rule Name                               | Count | Percentage | Severity Distribution |
| --------------------------------------- | ----- | ---------- | --------------------- |
| correctness/noUnusedVariables           | 154   | 28.9%      | 154W                  |
| style/noNonNullAssertion                | 95    | 17.8%      | 95W                   |
| style/useTemplate                       | 87    | 16.3%      | 87W                   |
| complexity/useOptionalChain             | 36    | 6.8%       | 36W                   |
| correctness/useExhaustiveDependencies   | 25    | 4.7%       | 25W                   |
| correctness/noUnusedImports             | 19    | 3.6%       | 19W                   |
| style/useNodejsImportProtocol           | 16    | 3.0%       | 16W                   |
| suspicious/useIterableCallbackReturn    | 16    | 3.0%       | 16W                   |
| complexity/useLiteralKeys               | 13    | 2.4%       | 13W                   |
| suspicious/noExplicitAny                | 11    | 2.1%       | 11W                   |
| suspicious/noArrayIndexKey              | 11    | 2.1%       | 11W                   |
| complexity/noStaticOnlyClass            | 10    | 1.9%       | 10W                   |
| suspicious/noImplicitAnyLet             | 9     | 1.7%       | 9W                    |
| correctness/noUnusedFunctionParameters  | 8     | 1.5%       | 8W                    |
| correctness/useParseIntRadix            | 3     | 0.6%       | 3W                    |
| complexity/noUselessCatch               | 2     | 0.4%       | 2W                    |
| complexity/noUselessTernary             | 2     | 0.4%       | 2W                    |
| suspicious/noEmptyBlock                 | 2     | 0.4%       | 2W                    |
| suspicious/noGlobalIsNan                | 2     | 0.4%       | 2W                    |
| correctness/noUnusedPrivateClassMembers | 2     | 0.4%       | 2W                    |
| suspicious/noAssignInExpressions        | 2     | 0.4%       | 2W                    |
| complexity/noUselessConstructor         | 1     | 0.2%       | 1W                    |
| complexity/noUselessFragments           | 1     | 0.2%       | 1W                    |
| complexity/noUselessSwitchCase          | 1     | 0.2%       | 1W                    |
| suspicious/noConfusingVoidType          | 1     | 0.2%       | 1W                    |
| suspicious/noIrregularWhitespace        | 1     | 0.2%       | 1W                    |
| complexity/noImportantStyles            | 1     | 0.2%       | 1W                    |
| correctness/useHookAtTopLevel           | 1     | 0.2%       | 1W                    |
| suspicious/noControlCharactersInRegex   | 1     | 0.2%       | 1E                    |

## Files with Most Issues

| File                                                           | Type Errors | Deno Lint | Biome | Total |
| -------------------------------------------------------------- | ----------- | --------- | ----- | ----- |
| tools/atlas-installer/main.js                                  | 0           | 86        | 32    | 118   |
| src/cli/modules/sessions/fetcher.test.ts                       | 57          | 18        | 0     | 75    |
| packages/memory/src/supervisor-memory-coordinator.ts           | 47          | 2         | 2     | 51    |
| tools/memory_manager/src/tui.ts                                | 8           | 9         | 26    | 43    |
| packages/memory/src/streaming/memory-stream-processors.ts      | 38          | 1         | 1     | 40    |
| tests/unit/workspace-add-cli.test.ts                           | 28          | 0         | 9     | 37    |
| apps/web-client/src/lib/modules/client/daemon.ts               | 26          | 3         | 3     | 32    |
| packages/memory/src/web-embedding-provider.ts                  | 25          | 0         | 7     | 32    |
| apps/diagnostics/src/paths.ts                                  | 10          | 10        | 10    | 30    |
| src/cli/components/signal-details.tsx                          | 27          | 0         | 1     | 28    |
| src/utils/version-checker.integration.test.ts                  | 28          | 0         | 0     | 28    |
| src/utils/paths.ts                                             | 11          | 8         | 8     | 27    |
| src/core/manager.ts                                            | 23          | 1         | 1     | 25    |
| packages/mcp-server/src/tools/utils.ts                         | 20          | 1         | 3     | 24    |
| src/cli/utils/daemon-client.ts                                 | 22          | 1         | 1     | 24    |
| src/cli/utils/prompts.tsx                                      | 5           | 11        | 8     | 24    |
| tests/unit/workspace-add.test.ts                               | 20          | 2         | 2     | 24    |
| packages/cron/tests/timer-signal-workspace-integration.test.ts | 0           | 0         | 21    | 21    |
| packages/client/src/client.ts                                  | 19          | 0         | 1     | 20    |
| src/core/actors/session-supervisor-actor.ts                    | 11          | 1         | 8     | 20    |
| ... and 268 more files                                         |             |           |       |       |

## Issues by Project

| Project                 | Type Errors | Deno Lint | Biome | Total |
| ----------------------- | ----------- | --------- | ----- | ----- |
| src                     | 427         | 101       | 212   | 740   |
| packages/memory         | 154         | 33        | 40    | 227   |
| tests                   | 113         | 10        | 21    | 144   |
| tools/atlas-installer   | 0           | 92        | 47    | 139   |
| packages/core           | 75          | 20        | 35    | 130   |
| packages/mcp-server     | 89          | 3         | 10    | 102   |
| apps/atlasd             | 56          | 3         | 26    | 85    |
| tools/memory_manager    | 27          | 11        | 29    | 67    |
| apps/diagnostics        | 29          | 14        | 24    | 67    |
| packages/storage        | 39          | 6         | 12    | 57    |
| packages/cron           | 11          | 0         | 43    | 54    |
| apps/web-client         | 41          | 5         | 7     | 53    |
| packages/signals        | 23          | 6         | 7     | 36    |
| packages/client         | 22          | 1         | 4     | 27    |
| other                   | 13          | 4         | 4     | 21    |
| packages/system         | 13          | 1         | 2     | 16    |
| packages/agent-sdk      | 8           | 0         | 0     | 8     |
| packages/notifications  | 8           | 0         | 0     | 8     |
| packages/mcp            | 3           | 0         | 3     | 6     |
| tools/evals             | 2           | 2         | 2     | 6     |
| packages/config         | 2           | 0         | 1     | 3     |
| packages/logger         | 1           | 0         | 2     | 3     |
| packages/openapi-client | 1           | 0         | 2     | 3     |
| packages/workspace      | 1           | 0         | 0     | 1     |
| packages/bundled-agents | 1           | 0         | 0     | 1     |

## Workspace Dependency Graph

### Dependency Analysis

| Package                 | Dependencies                                                                         | Dependents                                                                                                       | Complexity Score |
| ----------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- | ---------------- |
| logger                  | utils                                                                                | atlasd, agent-sdk, core, memory, signals, workspace, mcp, bundled-agents, system, fs-watch, notifications, evals | 25               |
| atlasd                  | config, core, utils, logger, workspace, storage, agent-sdk, cron, mcp-server, memory | mcp-server, mcp, client, openapi-client, evals                                                                   | 20               |
| core                    | config, logger, mcp, agent-sdk, bundled-agents, oapi-client, memory                  | diagnostics, web-client, atlasd, client, evals                                                                   | 17               |
| config                  | agent-sdk, storage                                                                   | atlasd, core, workspace, mcp-server, system, notifications                                                       | 14               |
| utils                   | none                                                                                 | diagnostics, atlasd, logger, memory, storage, system, evals                                                      | 14               |
| agent-sdk               | logger                                                                               | atlasd, core, config, bundled-agents, system, evals                                                              | 13               |
| memory                  | storage, logger, utils                                                               | atlasd, core, storage, system, memory_manager                                                                    | 13               |
| workspace               | config, logger, storage, system, fs-watch                                            | atlasd, cron, memory_manager                                                                                     | 11               |
| system                  | logger, config, agent-sdk, bundled-agents, utils, oapi-client, memory                | workspace, evals                                                                                                 | 11               |
| storage                 | memory, utils                                                                        | atlasd, memory, config, workspace                                                                                | 10               |
| bundled-agents          | agent-sdk, logger                                                                    | core, system, evals                                                                                              | 8                |
| evals                   | system, agent-sdk, bundled-agents, logger, atlasd, oapi-client, core, utils          | none                                                                                                             | 8                |
| mcp-server              | oapi-client, notifications, config, atlasd                                           | atlasd                                                                                                           | 6                |
| mcp                     | logger, atlasd                                                                       | core                                                                                                             | 4                |
| client                  | atlasd, core                                                                         | diagnostics                                                                                                      | 4                |
| notifications           | config, logger                                                                       | mcp-server                                                                                                       | 4                |
| diagnostics             | client, utils, core                                                                  | none                                                                                                             | 3                |
| fs-watch                | logger                                                                               | workspace                                                                                                        | 3                |
| cron                    | workspace                                                                            | atlasd                                                                                                           | 3                |
| web-client              | core, oapi-client                                                                    | none                                                                                                             | 2                |
| memory_manager          | memory, workspace                                                                    | none                                                                                                             | 2                |
| signals                 | logger                                                                               | none                                                                                                             | 1                |
| openapi-client          | atlasd                                                                               | none                                                                                                             | 1                |
| typescript-error-report | none                                                                                 | none                                                                                                             | 0                |
| src                     | none                                                                                 | none                                                                                                             | 0                |

### Recommended Fix Order

Based on the dependency graph, here's a recommended order for fixing errors:

1. **Start with leaf nodes** (no other packages depend on these):
   - diagnostics (29 errors)
   - web-client (41 errors)
   - signals (23 errors)
   - openapi-client (1 errors)
   - memory_manager (27 errors)
   - evals (2 errors)

2. **Then fix middle-tier packages** (1-3 dependents):
   - workspace (1 errors, 3 dependents)
   - mcp-server (89 errors, 1 dependents)
   - mcp (3 errors, 1 dependents)
   - bundled-agents (1 errors, 3 dependents)
   - system (13 errors, 2 dependents)
   - client (22 errors, 1 dependents)
   - notifications (8 errors, 1 dependents)
   - cron (11 errors, 1 dependents)

3. **Finally, fix core packages** (many packages depend on these):
   - atlasd (56 errors, 5 dependents)
   - agent-sdk (8 errors, 6 dependents)
   - core (75 errors, 5 dependents)
   - logger (1 errors, 12 dependents)
   - memory (154 errors, 5 dependents)
   - config (2 errors, 6 dependents)
   - storage (39 errors, 4 dependents)

## Code Quality Hotspots Analysis

### Most Common Issue Patterns

Issues that appear across multiple files (potential systematic problems):

- **[Biome] correctness/noUnusedVariables**: "Unused variables are often the
  result of an incomp..."
  - Occurrences: 154
  - Files affected: 78

- **[Biome] style/noNonNullAssertion**: "Unsafe fix..."
  - Occurrences: 95
  - Files affected: 19

- **[Biome] style/useTemplate**: "Template literals are preferred over string
  concat..."
  - Occurrences: 87
  - Files affected: 43

- **[Type] TS7053**: "Element implicitly has an 'any' type because expre..."
  - Occurrences: 42
  - Files affected: 18

- **[Type] TS18046**: "'data' is of type 'unknown'...."
  - Occurrences: 38
  - Files affected: 5

- **[Type] TS2532**: "Object is possibly 'undefined'...."
  - Occurrences: 35
  - Files affected: 7

- **[Deno Lint] require-await**: "Async arrow function has no 'await' expression
  or ..."
  - Occurrences: 35
  - Files affected: 6

- **[Type] TS2345**: "Argument of type 'unknown' is not assignable to pa..."
  - Occurrences: 26
  - Files affected: 16

- **[Type] TS18046**: "'result' is of type 'unknown'...."
  - Occurrences: 23
  - Files affected: 9

- **[Type] TS18046**: "'memory' is of type 'unknown'...."
  - Occurrences: 19
  - Files affected: 3

- **[Biome] correctness/noUnusedImports**: "Unused imports might be the result
  of an incomplet..."
  - Occurrences: 19
  - Files affected: 18

- **[Type] TS18046**: "'errorData' is of type 'unknown'...."
  - Occurrences: 17
  - Files affected: 14

- **[Type] TS18046**: "'error' is of type 'unknown'...."
  - Occurrences: 17
  - Files affected: 9

- **[Biome] suspicious/useIterableCallbackReturn**: "This callback passed to
  forEach() iterable method ..."
  - Occurrences: 16
  - Files affected: 7

- **[Type] TS2769**: "No overload matches this call...."
  - Occurrences: 14
  - Files affected: 10

### High-Impact Files

Files with issues from multiple tools (need attention):

| File                                                      | Type Errors | Deno Lint | Biome | Total |
| --------------------------------------------------------- | ----------- | --------- | ----- | ----- |
| tools/atlas-installer/main.js                             | 0           | 86        | 32    | 118   |
| src/cli/modules/sessions/fetcher.test.ts                  | 57          | 18        | 0     | 75    |
| packages/memory/src/supervisor-memory-coordinator.ts      | 47          | 2         | 2     | 51    |
| tools/memory_manager/src/tui.ts                           | 8           | 9         | 26    | 43    |
| packages/memory/src/streaming/memory-stream-processors.ts | 38          | 1         | 1     | 40    |
| tests/unit/workspace-add-cli.test.ts                      | 28          | 0         | 9     | 37    |
| apps/web-client/src/lib/modules/client/daemon.ts          | 26          | 3         | 3     | 32    |
| packages/memory/src/web-embedding-provider.ts             | 25          | 0         | 7     | 32    |
| apps/diagnostics/src/paths.ts                             | 10          | 10        | 10    | 30    |
| src/cli/components/signal-details.tsx                     | 27          | 0         | 1     | 28    |
