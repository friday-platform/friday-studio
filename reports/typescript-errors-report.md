# TypeScript & Lint Analysis Report

**Generated:** 2025-10-10T18:29:30.264Z

**Total Issues:** 16 (2 type errors, 0 deno lint violations, 14 biome
violations)

## Summary Statistics

### TypeScript Errors

- **Total errors:** 2
- **Unique error types:** 2
- **Files with errors:** 2

### Deno Lint Violations

- **Total violations:** 0
- **Unique rules violated:** 0
- **Files with violations:** 0

### Biome Violations

- **Total violations:** 14
- **Errors:** 1
- **Warnings:** 13
- **Unique rules violated:** 10
- **Files with violations:** 9

## TypeScript Error Types Breakdown

| Error Code | Count | Percentage | Description                      |
| ---------- | ----- | ---------- | -------------------------------- |
| TS2307     | 1     | 50.0%      | Cannot find module               |
| TS2578     | 1     | 50.0%      | Unused ts-expect-error directive |

## Deno Lint Rules Breakdown

No lint violations found.

## Biome Rules Breakdown

| Rule Name                               | Count | Percentage | Severity Distribution |
| --------------------------------------- | ----- | ---------- | --------------------- |
| correctness/noUnusedFunctionParameters  | 3     | 21.4%      | 3W                    |
| suspicious/noEmptyBlock                 | 2     | 14.3%      | 2W                    |
| correctness/noUnusedPrivateClassMembers | 2     | 14.3%      | 2W                    |
| style/useTemplate                       | 1     | 7.1%       | 1W                    |
| complexity/noUselessCatch               | 1     | 7.1%       | 1W                    |
| correctness/noUnusedVariables           | 1     | 7.1%       | 1W                    |
| suspicious/noExplicitAny                | 1     | 7.1%       | 1W                    |
| suspicious/noIrregularWhitespace        | 1     | 7.1%       | 1W                    |
| complexity/noImportantStyles            | 1     | 7.1%       | 1W                    |
| style/noNonNullAssertion                | 1     | 7.1%       | 1E                    |

## Files with Most Issues

| File                                                      | Type Errors | Deno Lint | Biome | Total |
| --------------------------------------------------------- | ----------- | --------- | ----- | ----- |
| apps/atlas-installer/src/renderer.ts                      | 0           | 0         | 3     | 3     |
| apps/atlas-installer/src/services/macos-service.ts        | 0           | 0         | 3     | 3     |
| apps/atlas-installer/styles.css                           | 0           | 0         | 2     | 2     |
| apps/web-client/.vite/deps/svelte_motion.js               | 1           | 0         | 0     | 1     |
| packages/system/agents/conversation/conversation.agent.ts | 1           | 0         | 0     | 1     |
| apps/atlas-installer/vendor.ts                            | 0           | 0         | 1     | 1     |
| packages/diagnostics/src/send-diagnostics.ts              | 0           | 0         | 1     | 1     |
| apps/atlas-installer/reset.css                            | 0           | 0         | 1     | 1     |
| apps/atlas-installer/src/utils/browser-compat.ts          | 0           | 0         | 1     | 1     |
| apps/web-client/src/reset.css                             | 0           | 0         | 1     | 1     |
| packages/core/src/agent-server/agent-execution-machine.ts | 0           | 0         | 1     | 1     |

## Issues by Project

| Project              | Type Errors | Deno Lint | Biome | Total |
| -------------------- | ----------- | --------- | ----- | ----- |
| apps/atlas-installer | 0           | 0         | 11    | 11    |
| apps/web-client      | 1           | 0         | 1     | 2     |
| packages/system      | 1           | 0         | 0     | 1     |
| packages/diagnostics | 0           | 0         | 1     | 1     |
| packages/core        | 0           | 0         | 1     | 1     |

## Workspace Dependency Graph

### Dependency Analysis

| Package                 | Dependencies                                                                                  | Dependents                                                                                                                         | Complexity Score |
| ----------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| utils                   | none                                                                                          | web-client, atlasd, core, logger, memory, config, signals, mcp-server, bundled-agents, storage, system, diagnostics, client, evals | 28               |
| logger                  | utils                                                                                         | atlasd, agent-sdk, core, memory, signals, workspace, mcp-server, mcp, bundled-agents, system, fs-watch, diagnostics, notifications | 27               |
| core                    | config, logger, mcp, utils, agent-sdk, bundled-agents, oapi-client, client, memory            | web-client, atlasd, agent-sdk, mcp-server, bundled-agents, system, client, evals                                                   | 25               |
| atlasd                  | core, logger, utils, config, storage, agent-sdk, cron, mcp-server, memory, workspace, signals | mcp-server, mcp, client, openapi-client, evals                                                                                     | 21               |
| client                  | utils, atlasd, core, oapi-client                                                              | web-client, core, mcp-server, system, diagnostics, evals                                                                           | 16               |
| config                  | utils, agent-sdk, storage                                                                     | atlasd, core, workspace, mcp-server, system, notifications                                                                         | 15               |
| agent-sdk               | logger, core                                                                                  | atlasd, core, config, bundled-agents, system, evals                                                                                | 14               |
| memory                  | storage, logger, utils                                                                        | atlasd, core, storage, system, memory_manager                                                                                      | 13               |
| workspace               | config, logger, storage, system, fs-watch                                                     | atlasd, diagnostics, cron, memory_manager                                                                                          | 13               |
| system                  | agent-sdk, client, core, utils, config, bundled-agents, logger, memory, oapi-client           | workspace, evals                                                                                                                   | 13               |
| mcp-server              | client, utils, core, logger, oapi-client, config, notifications, atlasd                       | atlasd                                                                                                                             | 10               |
| bundled-agents          | agent-sdk, core, logger, utils                                                                | core, system, evals                                                                                                                | 10               |
| storage                 | memory, utils                                                                                 | atlasd, memory, config, workspace                                                                                                  | 10               |
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
| atlas-installer         | none                                                                                          | none                                                                                                                               | 0                |
| typescript-error-report | none                                                                                          | none                                                                                                                               | 0                |
| src                     | none                                                                                          | none                                                                                                                               | 0                |

### Recommended Fix Order

Based on the dependency graph, here's a recommended order for fixing errors:

1. **Start with leaf nodes** (no other packages depend on these):
   - web-client (1 errors)

2. **Then fix middle-tier packages** (1-3 dependents):
   - system (1 errors, 2 dependents)

3. **Finally, fix core packages** (many packages depend on these):

## Code Quality Hotspots Analysis
