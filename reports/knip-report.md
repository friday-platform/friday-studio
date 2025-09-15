No Svelte config file found in /Users/ericskram/code/tempest/atlas-env/worktrees/type-cleanup-9-15-2 - using SvelteKit's default configuration without an adapter.
# Knip report

## Unused files (30)

* packages/mcp-server/src/tools/signals/describe.ts
* packages/memory/src/utils/safe-date-conversion.ts
* src/cli/commands/workspace/restart.tsx
* src/cli/components/agent-details.tsx
* src/cli/components/directory-tree.tsx
* src/cli/components/error-alert.tsx
* src/cli/components/git-diff.tsx
* src/cli/components/job-details.tsx
* src/cli/components/leader-key-overlay.tsx
* src/cli/components/log-viewer.tsx
* src/cli/components/multi-select.tsx
* src/cli/components/signal-action-selection.tsx
* src/cli/components/signal-details.tsx
* src/cli/modules/agents/processor.ts
* src/cli/modules/conversation/WorkspacesCommand.tsx
* src/cli/modules/conversation/job-details-with-path.tsx
* src/cli/modules/conversation/signal-details-with-path.tsx
* src/cli/modules/conversation/utils.ts
* src/cli/modules/input/index.ts
* src/cli/modules/library/fetcher.ts
* src/cli/modules/messages/components/tool-call.tsx
* src/cli/types/health.ts
* src/cli/utils/index.ts
* src/cli/utils/workspace-loader.ts
* src/cli/views/ConfigView.tsx
* src/cli/views/InitView.tsx
* src/core/embedding/mock-embedding-provider.ts
* src/types/vector-search.ts
* src/utils/memory-id-migration.ts
* src/utils/memory-migration.ts

## Unused dependencies (4)

| Name                     | Location                          | Severity |
| :----------------------- | :-------------------------------- | :------- |
| @atlas/workspace         | packages/system/package.json:16:6 | error    |
| @atlas/core              | packages/system/package.json:11:6 | error    |
| @hono/standard-validator | package.json:31:6                 | error    |
| @biomejs/biome           | package.json:30:6                 | error    |

## Unused devDependencies (1)

| Name             | Location                           | Severity |
| :--------------- | :--------------------------------- | :------- |
| electron-builder | tools/atlas-installer/package.json | warn     |

## Unlisted binaries (3)

| Name             | Location                                     | Severity |
| :--------------- | :------------------------------------------- | :------- |
| electron-builder | .github/actions/create-installers/action.yml | error    |
| electron-builder | tools/atlas-installer/package.json           | error    |
| electron         | tools/atlas-installer/package.json           | error    |

## Unused exported types (1)

| Name        | Location                                                 | Severity |
| :---------- | :------------------------------------------------------- | :------- |
| LibraryItem | src/cli/modules/library/library-list-component.tsx:22:13 | error    |

## Unused exported enum members (4)

| Name     | Location                                     | Severity |
| :------- | :------------------------------------------- | :------- |
| WORKFLOW | packages/signals/src/providers/types.ts:23:3 | warn     |
| SOURCE   | packages/signals/src/providers/types.ts:24:3 | warn     |
| ACTION   | packages/signals/src/providers/types.ts:25:3 | warn     |
| WATCHER  | src/types/core.ts:145:3                      | warn     |

