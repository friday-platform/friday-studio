# TypeScript & Lint Analysis Report

**Generated:** 2025-09-14T21:02:39.238Z

**Total Issues:** 751 (0 type errors, 254 deno lint violations, 497 biome
violations)

## Summary Statistics

### TypeScript Errors

- **Total errors:** 0
- **Unique error types:** 0
- **Files with errors:** 0

### Deno Lint Violations

- **Total violations:** 254
- **Unique rules violated:** 6
- **Files with violations:** 73

### Biome Violations

- **Total violations:** 497
- **Errors:** 7
- **Warnings:** 490
- **Unique rules violated:** 29
- **Files with violations:** 151

## TypeScript Error Types Breakdown

No TypeScript errors found.

## Deno Lint Rules Breakdown

| Rule Name         | Count | Percentage | Description                      |
| ----------------- | ----- | ---------- | -------------------------------- |
| require-await     | 118   | 46.5%      | Async function without await     |
| no-process-global | 64    | 25.2%      | Lint rule violation              |
| no-unused-vars    | 52    | 20.5%      | Variable declared but never used |
| no-explicit-any   | 11    | 4.3%       | Explicit 'any' type usage        |
| no-empty          | 8     | 3.1%       | Empty block statement            |
| no-control-regex  | 1     | 0.4%       | Control characters in regex      |

## Biome Rules Breakdown

| Rule Name                               | Count | Percentage | Severity Distribution |
| --------------------------------------- | ----- | ---------- | --------------------- |
| style/noNonNullAssertion                | 169   | 34.0%      | 169W                  |
| style/useTemplate                       | 89    | 17.9%      | 89W                   |
| complexity/useOptionalChain             | 39    | 7.8%       | 39W                   |
| correctness/noUnusedVariables           | 33    | 6.6%       | 33W                   |
| correctness/useExhaustiveDependencies   | 25    | 5.0%       | 25W                   |
| complexity/useLiteralKeys               | 17    | 3.4%       | 17W                   |
| correctness/noUnusedImports             | 17    | 3.4%       | 17W                   |
| style/useNodejsImportProtocol           | 16    | 3.2%       | 16W                   |
| suspicious/useIterableCallbackReturn    | 16    | 3.2%       | 4E/12W                |
| complexity/noStaticOnlyClass            | 11    | 2.2%       | 11W                   |
| suspicious/noExplicitAny                | 11    | 2.2%       | 11W                   |
| suspicious/noArrayIndexKey              | 11    | 2.2%       | 11W                   |
| suspicious/noImplicitAnyLet             | 9     | 1.8%       | 1E/8W                 |
| correctness/noUnusedFunctionParameters  | 8     | 1.6%       | 1E/7W                 |
| correctness/noUnusedPrivateClassMembers | 5     | 1.0%       | 5W                    |
| correctness/useParseIntRadix            | 3     | 0.6%       | 3W                    |
| complexity/noUselessCatch               | 2     | 0.4%       | 2W                    |
| complexity/noUselessTernary             | 2     | 0.4%       | 2W                    |
| suspicious/noEmptyBlock                 | 2     | 0.4%       | 2W                    |
| suspicious/noGlobalIsNan                | 2     | 0.4%       | 2W                    |
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

| File                                                                | Type Errors | Deno Lint | Biome | Total |
| ------------------------------------------------------------------- | ----------- | --------- | ----- | ----- |
| tools/atlas-installer/main.js                                       | 0           | 86        | 32    | 118   |
| tools/memory_manager/src/tui.ts                                     | 0           | 9         | 26    | 35    |
| integration-tests/config-loader-migration.test.ts                   | 0           | 0         | 30    | 30    |
| packages/system/agents/conversation/tools/workspace-update/tools.ts | 0           | 0         | 23    | 23    |
| integration-tests/configuration-architecture.test.ts                | 0           | 0         | 22    | 22    |
| packages/cron/tests/timer-signal-workspace-integration.test.ts      | 0           | 0         | 21    | 21    |
| src/cli/modules/sessions/fetcher.test.ts                            | 0           | 18        | 0     | 18    |
| src/cli/modules/input/tests/file-path-detector-extended.test.ts     | 0           | 0         | 14    | 14    |
| src/cli/components/agent-details.tsx                                | 0           | 6         | 7     | 13    |
| tools/atlas-installer/renderer.js                                   | 0           | 3         | 8     | 11    |
| src/cli/commands/workspace/add.tsx                                  | 0           | 0         | 11    | 11    |
| packages/cron/tests/timer-signal-error-recovery.test.ts             | 0           | 0         | 11    | 11    |
| packages/cron/tests/timer-signal-storage-persistence.test.ts        | 0           | 0         | 11    | 11    |
| src/core/caching/adapters/memory-cache-adapter.ts                   | 0           | 10        | 0     | 10    |
| src/cli/utils/prompts.tsx                                           | 0           | 6         | 3     | 9     |
| src/core/actors/session-supervisor-actor.ts                         | 0           | 1         | 8     | 9     |
| packages/memory/src/coala-memory.ts                                 | 0           | 5         | 4     | 9     |
| tests/unit/workspace-add-cli.test.ts                                | 0           | 0         | 9     | 9     |
| src/core/storage/memory-kv-storage.ts                               | 0           | 8         | 0     | 8     |
| packages/memory/tests/coala-memory-working.test.ts                  | 0           | 8         | 0     | 8     |
| ... and 155 more files                                              |             |           |       |       |

## Issues by Project

| Project                 | Type Errors | Deno Lint | Biome | Total |
| ----------------------- | ----------- | --------- | ----- | ----- |
| src                     | 0           | 73        | 162   | 235   |
| tools/atlas-installer   | 0           | 92        | 47    | 139   |
| integration-tests       | 0           | 9         | 59    | 68    |
| packages/memory         | 0           | 30        | 34    | 64    |
| packages/cron           | 0           | 0         | 43    | 43    |
| tools/memory_manager    | 0           | 9         | 27    | 36    |
| tests                   | 0           | 10        | 21    | 31    |
| packages/core           | 0           | 11        | 19    | 30    |
| packages/system         | 0           | 0         | 25    | 25    |
| packages/storage        | 0           | 6         | 12    | 18    |
| packages/signals        | 0           | 6         | 6     | 12    |
| apps/atlasd             | 0           | 2         | 9     | 11    |
| apps/diagnostics        | 0           | 0         | 10    | 10    |
| other                   | 0           | 4         | 4     | 8     |
| packages/mcp-server     | 0           | 0         | 7     | 7     |
| tools/evals             | 0           | 2         | 2     | 4     |
| packages/mcp            | 0           | 0         | 3     | 3     |
| packages/logger         | 0           | 0         | 2     | 2     |
| packages/openapi-client | 0           | 0         | 2     | 2     |
| apps/web-client         | 0           | 0         | 1     | 1     |
| packages/client         | 0           | 0         | 1     | 1     |
| packages/config         | 0           | 0         | 1     | 1     |

## Workspace Dependency Graph

### Dependency Analysis

| Package                 | Dependencies                                                                           | Dependents                                                                                                       | Complexity Score |
| ----------------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ---------------- |
| logger                  | utils                                                                                  | atlasd, agent-sdk, core, memory, signals, workspace, mcp, bundled-agents, system, fs-watch, notifications, evals | 25               |
| atlasd                  | config, core, utils, logger, workspace, storage, agent-sdk, cron, mcp-server, memory   | mcp-server, mcp, client, openapi-client, evals                                                                   | 20               |
| core                    | config, logger, mcp, agent-sdk, bundled-agents, oapi-client, memory                    | diagnostics, web-client, atlasd, system, client, evals                                                           | 19               |
| config                  | agent-sdk, storage                                                                     | atlasd, core, workspace, mcp-server, system, notifications                                                       | 14               |
| utils                   | none                                                                                   | diagnostics, atlasd, logger, memory, storage, system, evals                                                      | 14               |
| agent-sdk               | logger                                                                                 | atlasd, core, config, bundled-agents, system, evals                                                              | 13               |
| memory                  | storage, logger, utils                                                                 | atlasd, core, storage, system, memory_manager                                                                    | 13               |
| workspace               | config, logger, storage, system, fs-watch                                              | atlasd, system, cron, memory_manager                                                                             | 13               |
| system                  | logger, config, agent-sdk, bundled-agents, utils, oapi-client, workspace, core, memory | workspace, evals                                                                                                 | 13               |
| storage                 | memory, utils                                                                          | atlasd, memory, config, workspace                                                                                | 10               |
| bundled-agents          | agent-sdk, logger                                                                      | core, system, evals                                                                                              | 8                |
| evals                   | system, agent-sdk, bundled-agents, logger, atlasd, oapi-client, core, utils            | none                                                                                                             | 8                |
| mcp-server              | oapi-client, notifications, config, atlasd                                             | atlasd                                                                                                           | 6                |
| mcp                     | logger, atlasd                                                                         | core                                                                                                             | 4                |
| client                  | atlasd, core                                                                           | diagnostics                                                                                                      | 4                |
| notifications           | config, logger                                                                         | mcp-server                                                                                                       | 4                |
| diagnostics             | client, utils, core                                                                    | none                                                                                                             | 3                |
| fs-watch                | logger                                                                                 | workspace                                                                                                        | 3                |
| cron                    | workspace                                                                              | atlasd                                                                                                           | 3                |
| web-client              | core, oapi-client                                                                      | none                                                                                                             | 2                |
| memory_manager          | memory, workspace                                                                      | none                                                                                                             | 2                |
| signals                 | logger                                                                                 | none                                                                                                             | 1                |
| openapi-client          | atlasd                                                                                 | none                                                                                                             | 1                |
| typescript-error-report | none                                                                                   | none                                                                                                             | 0                |
| src                     | none                                                                                   | none                                                                                                             | 0                |

### Recommended Fix Order

Based on the dependency graph, here's a recommended order for fixing errors:

1. **Start with leaf nodes** (no other packages depend on these):

2. **Then fix middle-tier packages** (1-3 dependents):

3. **Finally, fix core packages** (many packages depend on these):

## Code Quality Hotspots Analysis

### Most Common Issue Patterns

Issues that appear across multiple files (potential systematic problems):

- **[Biome] style/noNonNullAssertion**: "Unsafe fix..."
  - Occurrences: 169
  - Files affected: 23

- **[Biome] style/useTemplate**: "Template literals are preferred over string
  concat..."
  - Occurrences: 89
  - Files affected: 45

- **[Deno Lint] require-await**: "Async arrow function has no 'await' expression
  or ..."
  - Occurrences: 41
  - Files affected: 8

- **[Biome] correctness/noUnusedVariables**: "Unused variables are often the
  result of an incomp..."
  - Occurrences: 33
  - Files affected: 20

- **[Biome] complexity/useLiteralKeys**: "The computed expression can be
  simplified without ..."
  - Occurrences: 17
  - Files affected: 9

- **[Biome] correctness/noUnusedImports**: "Unused imports might be the result
  of an incomplet..."
  - Occurrences: 17
  - Files affected: 16

- **[Biome] suspicious/useIterableCallbackReturn**: "This callback passed to
  forEach() iterable method ..."
  - Occurrences: 16
  - Files affected: 7

- **[Deno Lint] no-explicit-any**: "`any` type is not allowed..."
  - Occurrences: 11
  - Files affected: 4

- **[Biome] complexity/noStaticOnlyClass**: "Prefer using simple functions
  instead of classes w..."
  - Occurrences: 11
  - Files affected: 9

- **[Biome] suspicious/noExplicitAny**: "any disables many type checking rules.
  Its use sho..."
  - Occurrences: 11
  - Files affected: 4

- **[Biome] suspicious/noArrayIndexKey**: "Avoid using the index of an array as
  key property ..."
  - Occurrences: 11
  - Files affected: 7

- **[Biome] suspicious/noImplicitAnyLet**: "This variable implicitly has the any
  type. Variabl..."
  - Occurrences: 9
  - Files affected: 9

- **[Deno Lint] no-empty**: "Empty block statement..."
  - Occurrences: 8
  - Files affected: 4

- **[Deno Lint] no-unused-vars**: "`error` is never used..."
  - Occurrences: 8
  - Files affected: 7

- **[Biome] correctness/noUnusedFunctionParameters**: "Unused parameters might
  be the result of an incomp..."
  - Occurrences: 8
  - Files affected: 5

### High-Impact Files

Files with issues from multiple tools (need attention):

| File                                        | Type Errors | Deno Lint | Biome | Total |
| ------------------------------------------- | ----------- | --------- | ----- | ----- |
| tools/atlas-installer/main.js               | 0           | 86        | 32    | 118   |
| tools/memory_manager/src/tui.ts             | 0           | 9         | 26    | 35    |
| src/cli/components/agent-details.tsx        | 0           | 6         | 7     | 13    |
| tools/atlas-installer/renderer.js           | 0           | 3         | 8     | 11    |
| src/cli/utils/prompts.tsx                   | 0           | 6         | 3     | 9     |
| src/core/actors/session-supervisor-actor.ts | 0           | 1         | 8     | 9     |
| packages/memory/src/coala-memory.ts         | 0           | 5         | 4     | 9     |
| src/cli/utils/conversation-client.ts        | 0           | 3         | 3     | 6     |
| src/cli/components/log-viewer.tsx           | 0           | 2         | 4     | 6     |
| src/cli/modules/messages/message-buffer.tsx | 0           | 1         | 5     | 6     |
