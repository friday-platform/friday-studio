No Svelte config file found in /Users/ericskram/code/tempest/atlas-env/worktrees/type-cleanup-9-25 - using SvelteKit's default configuration without an adapter.
# Knip report

## Unused files (17)

* apps/diagnostics/src/open-files/mod.ts
* apps/web-client/src/lib/components/about-dialog.svelte
* apps/web-client/src/lib/components/icons/custom/calendar.svelte
* apps/web-client/src/lib/components/settings-dialog.svelte
* packages/core/src/artifacts/mod.ts
* packages/core/src/artifacts/model.ts
* packages/core/src/artifacts/storage.ts
* packages/mcp-server/src/tools/artifacts/create.ts
* packages/mcp-server/src/tools/artifacts/delete.ts
* packages/mcp-server/src/tools/artifacts/get-by-chat.ts
* packages/mcp-server/src/tools/artifacts/get.ts
* packages/mcp-server/src/tools/artifacts/index.ts
* packages/mcp-server/src/tools/artifacts/update.ts
* packages/utils/src/paths.ts
* packages/utils/src/telemetry.ts
* tools/evals/agents/google-calendar-agent/extracting-portfolio-meetings.ts
* tools/evals/agents/research/research-tasks.ts

## Unused dependencies (7)

| Name                     | Location                          | Severity |
| :----------------------- | :-------------------------------- | :------- |
| @atlas/workspace         | packages/system/package.json:16:6 | error    |
| @atlas/core              | packages/system/package.json:11:6 | error    |
| cookie                   | apps/web-client/package.json:32:6 | error    |
| @opentelemetry/api       | packages/utils/package.json:7:6   | error    |
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

## Unresolved imports (2)

| Name                                     | Location                                                   | Severity |
| :--------------------------------------- | :--------------------------------------------------------- | :------- |
| ../../../../../src/core/library/types.ts | apps/web-client/src/routes/(app)/library/+page.svelte:4:34 | error    |
| $lib/build-info                          | apps/web-client/src/routes/about/+page.svelte:4:28         | error    |

## Unused exports (2)

| Name            | Location                              | Severity |
| :-------------- | :------------------------------------ | :------- |
| artifactsApp    | apps/atlasd/routes/artifacts.ts:130:9 | error    |
| getAtlasLogsDir | src/utils/paths.ts:9:17               | error    |

## Unused exported enum members (2)

| Name    | Location                          | Severity |
| :------ | :-------------------------------- | :------- |
| Stable  | src/utils/release-channel.ts:10:3 | warn     |
| WATCHER | src/types/core.ts:145:3           | warn     |

