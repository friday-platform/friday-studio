No Svelte config file found in /Users/ericskram/code/tempest/atlas-env/worktrees/type-cleanup-9-23 - using SvelteKit's default configuration without an adapter.
# Knip report

## Unused files (20)

* apps/web-client/src/lib/components/about-dialog.svelte
* apps/web-client/src/lib/components/icons/custom/calendar.svelte
* apps/web-client/src/lib/components/settings-dialog.svelte
* packages/mcp-server/src/tools/signals/describe.ts
* packages/utils/src/paths.ts
* src/cli/components/multi-select.tsx
* src/cli/modules/agents/processor.ts
* src/cli/modules/conversation/WorkspacesCommand.tsx
* src/cli/modules/conversation/utils.ts
* src/cli/modules/input/index.ts
* src/cli/modules/library/fetcher.ts
* src/cli/modules/messages/components/tool-call.tsx
* src/cli/modules/workspaces/creator.ts
* src/cli/types/health.ts
* src/cli/utils/index.ts
* src/cli/views/ConfigView.tsx
* src/cli/views/InitView.tsx
* src/types/vector-search.ts
* src/utils/port-finder.ts
* tools/evals/agents/google-calendar-agent/extracting-portfolio-meetings.ts

## Unused dependencies (6)

| Name                     | Location                          | Severity |
| :----------------------- | :-------------------------------- | :------- |
| @atlas/workspace         | packages/system/package.json:16:6 | error    |
| @atlas/core              | packages/system/package.json:11:6 | error    |
| cookie                   | apps/web-client/package.json:32:6 | error    |
| @atlas/agent-sdk         | apps/atlasd/package.json:8:6      | error    |
| @hono/standard-validator | package.json:31:6                 | error    |
| @biomejs/biome           | package.json:30:6                 | error    |

## Unused devDependencies (1)

| Name             | Location                                | Severity |
| :--------------- | :-------------------------------------- | :------- |
| electron-builder | tools/atlas-installer/package.json:37:6 | warn     |

## Unlisted binaries (2)

| Name             | Location                           | Severity |
| :--------------- | :--------------------------------- | :------- |
| electron-builder | tools/atlas-installer/package.json | error    |
| electron         | tools/atlas-installer/package.json | error    |

## Unresolved imports (3)

| Name                                     | Location                                                   | Severity |
| :--------------------------------------- | :--------------------------------------------------------- | :------- |
| ../../../../../src/core/library/types.ts | apps/web-client/src/routes/(app)/library/+page.svelte:4:34 | error    |
| ../../../tests/utils/mod.ts              | packages/cron/tests/cron-manager-concurrency.test.ts:10:23 | error    |
| $lib/build-info                          | apps/web-client/src/routes/about/+page.svelte:4:28         | error    |

## Unused exports (4)

| Name                   | Location                                    | Severity |
| :--------------------- | :------------------------------------------ | :------- |
| clearNotes             | apps/atlasd/src/storage/scratchpad.ts:40:23 | error    |
| TEMP_UI_MESSAGE_SCHEMA | apps/atlasd/routes/chat-storage.ts:10:14    | error    |
| LibraryItemSchema      | packages/mcp-server/src/schemas.ts:8:14     | error    |
| portSchema             | src/services/schemas.ts:8:14                | error    |

## Unused exported enum members (1)

| Name    | Location                | Severity |
| :------ | :---------------------- | :------- |
| WATCHER | src/types/core.ts:145:3 | warn     |

