# TypeScript & Lint Analysis Report

**Generated:** 2025-09-15T18:32:43.971Z

**Total Issues:** 10756 (1160 type errors, 312 deno lint violations, 9284 biome
violations)

## Summary Statistics

### TypeScript Errors

- **Total errors:** 1160
- **Unique error types:** 36
- **Files with errors:** 225

### Deno Lint Violations

- **Total violations:** 312
- **Unique rules violated:** 6
- **Files with violations:** 102

### Biome Violations

- **Total violations:** 9284
- **Errors:** 22
- **Warnings:** 9262
- **Unique rules violated:** 61
- **Files with violations:** 281

## TypeScript Error Types Breakdown

| Error Code | Count | Percentage | Description                                  |
| ---------- | ----- | ---------- | -------------------------------------------- |
| TS18046    | 299   | 25.8%      | Value is of type 'unknown'                   |
| TS2339     | 243   | 20.9%      | Property does not exist on type              |
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
| TS2307     | 1     | 0.1%       | Cannot find module                           |
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
| complexity/noCommaOperator              | 2420  | 26.1%      | 2420W                 |
| suspicious/noAssignInExpressions        | 2381  | 25.6%      | 1E/2380W              |
| suspicious/noDoubleEquals               | 972   | 10.5%      | 972W                  |
| style/useConst                          | 929   | 10.0%      | 929W                  |
| correctness/noInnerDeclarations         | 755   | 8.1%       | 2E/753W               |
| correctness/noUnusedVariables           | 279   | 3.0%       | 279W                  |
| style/useTemplate                       | 211   | 2.3%       | 211W                  |
| correctness/noUnusedFunctionParameters  | 194   | 2.1%       | 194W                  |
| complexity/useLiteralKeys               | 179   | 1.9%       | 179W                  |
| complexity/useArrowFunction             | 167   | 1.8%       | 167W                  |
| complexity/noUselessLoneBlockStatements | 105   | 1.1%       | 105W                  |
| complexity/useOptionalChain             | 101   | 1.1%       | 101W                  |
| style/noNonNullAssertion                | 95    | 1.0%       | 95W                   |
| complexity/noArguments                  | 55    | 0.6%       | 55W                   |
| suspicious/useIterableCallbackReturn    | 44    | 0.5%       | 44W                   |
| performance/noAccumulatingSpread        | 32    | 0.3%       | 32W                   |
| correctness/useExhaustiveDependencies   | 25    | 0.3%       | 25W                   |
| correctness/noSwitchDeclarations        | 24    | 0.3%       | 24W                   |
| suspicious/noExplicitAny                | 23    | 0.2%       | 23W                   |
| correctness/noUnusedImports             | 20    | 0.2%       | 20W                   |
| complexity/noUselessEscapeInRegex       | 18    | 0.2%       | 18W                   |
| suspicious/noPrototypeBuiltins          | 18    | 0.2%       | 18W                   |
| style/useNodejsImportProtocol           | 16    | 0.2%       | 16W                   |
| style/noDescendingSpecificity           | 16    | 0.2%       | 16W                   |
| complexity/noBannedTypes                | 16    | 0.2%       | 16W                   |
| correctness/useParseIntRadix            | 15    | 0.2%       | 15W                   |
| style/useExponentiationOperator         | 14    | 0.2%       | 14W                   |
| suspicious/noSelfCompare                | 11    | 0.1%       | 11E                   |
| suspicious/noArrayIndexKey              | 11    | 0.1%       | 11W                   |
| complexity/noUselessSwitchCase          | 10    | 0.1%       | 10W                   |
| ... and 31 more rules                   |       |            |                       |

## Files with Most Issues

| File                                                                         | Type Errors | Deno Lint | Biome | Total |
| ---------------------------------------------------------------------------- | ----------- | --------- | ----- | ----- |
| apps/web-client/.svelte-kit/output/client/_app/immutable/chunks/MK0idI-J.js  | 0           | 0         | 1038  | 1038  |
| apps/web-client/build/_app/immutable/chunks/MK0idI-J.js                      | 0           | 0         | 1038  | 1038  |
| apps/web-client/.svelte-kit/output/client/_app/immutable/chunks/DmpwpsuB.js  | 0           | 0         | 896   | 896   |
| apps/web-client/build/_app/immutable/chunks/DmpwpsuB.js                      | 0           | 0         | 896   | 896   |
| apps/web-client/.vite/deps/@lezer_markdown.js                                | 0           | 0         | 759   | 759   |
| apps/web-client/.vite/deps/ai.js                                             | 0           | 0         | 724   | 724   |
| apps/web-client/.svelte-kit/output/client/_app/immutable/chunks/DkHoLVM7.js  | 0           | 0         | 434   | 434   |
| apps/web-client/build/_app/immutable/chunks/DkHoLVM7.js                      | 0           | 0         | 434   | 434   |
| apps/web-client/.svelte-kit/output/client/_app/immutable/chunks/CZz9Gaa9.js  | 0           | 0         | 262   | 262   |
| apps/web-client/build/_app/immutable/chunks/CZz9Gaa9.js                      | 0           | 0         | 262   | 262   |
| apps/web-client/.vite/deps/chunk-FDUBBP2Z.js                                 | 0           | 0         | 196   | 196   |
| apps/web-client/.vite/deps/chunk-XYCBVIMZ.js                                 | 0           | 0         | 148   | 148   |
| apps/web-client/.svelte-kit/output/server/chunks/internal.js                 | 0           | 0         | 129   | 129   |
| apps/web-client/.svelte-kit/output/client/_app/immutable/nodes/0.uowOX_RE.js | 0           | 0         | 119   | 119   |
| apps/web-client/build/_app/immutable/nodes/0.uowOX_RE.js                     | 0           | 0         | 119   | 119   |
| tools/atlas-installer/main.js                                                | 0           | 86        | 32    | 118   |
| apps/web-client/.svelte-kit/output/client/_app/immutable/nodes/2.DkSvKLju.js | 0           | 0         | 99    | 99    |
| apps/web-client/build/_app/immutable/nodes/2.DkSvKLju.js                     | 0           | 0         | 99    | 99    |
| apps/web-client/.svelte-kit/output/client/_app/immutable/chunks/CleVlglB.js  | 0           | 0         | 91    | 91    |
| apps/web-client/build/_app/immutable/chunks/CleVlglB.js                      | 0           | 0         | 91    | 91    |
| ... and 362 more files                                                       |             |           |       |       |

## Issues by Project

| Project                 | Type Errors | Deno Lint | Biome | Total |
| ----------------------- | ----------- | --------- | ----- | ----- |
| apps/web-client         | 42          | 5         | 8758  | 8805  |
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
   - web-client (42 errors)
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

- **[Biome] complexity/noCommaOperator**: "Its use is often confusing and
  obscures side effec..."
  - Occurrences: 2420
  - Files affected: 36

- **[Biome] suspicious/noAssignInExpressions**: "The assignment should not be in
  an expression. The..."
  - Occurrences: 2381
  - Files affected: 58

- **[Biome] suspicious/noDoubleEquals**: "Using == may be unsafe if you are
  relying on type ..."
  - Occurrences: 758
  - Files affected: 26

- **[Biome] correctness/noInnerDeclarations**: "This var should be declared at
  the root of the enc..."
  - Occurrences: 755
  - Files affected: 33

- **[Biome] correctness/noUnusedVariables**: "Unused variables are often the
  result of an incomp..."
  - Occurrences: 279
  - Files affected: 102

- **[Biome] suspicious/noDoubleEquals**: "Using != may be unsafe if you are
  relying on type ..."
  - Occurrences: 214
  - Files affected: 12

- **[Biome] style/useTemplate**: "Template literals are preferred over string
  concat..."
  - Occurrences: 211
  - Files affected: 64

- **[Biome] correctness/noUnusedFunctionParameters**: "Unused parameters might
  be the result of an incomp..."
  - Occurrences: 194
  - Files affected: 43

- **[Biome] complexity/useLiteralKeys**: "The computed expression can be
  simplified without ..."
  - Occurrences: 179
  - Files affected: 11

- **[Biome] complexity/useArrowFunction**: "Function expressions that don't use
  this can be tu..."
  - Occurrences: 167
  - Files affected: 20

- **[Biome] complexity/noUselessLoneBlockStatements**: "This block statement
  doesn't serve any purpose and..."
  - Occurrences: 105
  - Files affected: 17

- **[Biome] style/noNonNullAssertion**: "Unsafe fix..."
  - Occurrences: 95
  - Files affected: 19

- **[Biome] style/useConst**: "'s' is never reassigned. Safe fix..."
  - Occurrences: 59
  - Files affected: 5

- **[Biome] complexity/noArguments**: "arguments does not have Array.prototype
  methods an..."
  - Occurrences: 55
  - Files affected: 8

- **[Type] TS7053**: "Element implicitly has an 'any' type because expre..."
  - Occurrences: 42
  - Files affected: 18

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
