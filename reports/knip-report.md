No Svelte config file found in /Users/lcf/code/github.com/tempestteam/atlas - using SvelteKit's default configuration without an adapter.
# Knip report

## Unused files (10)

* apps/web-client/src/lib/components/about-dialog.svelte
* apps/web-client/src/lib/components/icons/custom/calendar.svelte
* apps/web-client/src/lib/components/settings-dialog.svelte
* packages/core/src/artifacts/mod.ts
* packages/core/src/artifacts/model.ts
* packages/core/src/artifacts/storage.ts
* packages/utils/src/paths.ts
* packages/utils/src/telemetry.ts
* tools/evals/agents/google-calendar-agent/extracting-portfolio-meetings.ts
* tools/evals/agents/research/research-tasks.ts

## Unused dependencies (5)

| Name                     | Location                          | Severity |
| :----------------------- | :-------------------------------- | :------- |
| @atlas/workspace         | packages/system/package.json:16:6 | error    |
| cookie                   | apps/web-client/package.json:32:6 | error    |
| @opentelemetry/api       | packages/utils/package.json:7:6   | error    |
| @hono/standard-validator | package.json:31:6                 | error    |
| @biomejs/biome           | package.json:30:6                 | error    |

## Unresolved imports (1)

| Name                                     | Location                                                   | Severity |
| :--------------------------------------- | :--------------------------------------------------------- | :------- |
| ../../../../../src/core/library/types.ts | apps/web-client/src/routes/(app)/library/+page.svelte:4:34 | error    |

## Unused exports (9)

| Name                                    | Location                                        | Severity |
| :-------------------------------------- | :---------------------------------------------- | :------- |
| updateWorkspaceResponseSchema           | apps/atlasd/routes/workspaces/schemas.ts:101:14 | error    |
| signalTriggerResponseSchema             | apps/atlasd/routes/workspaces/schemas.ts:140:14 | error    |
| errorResponseSchema                     | apps/atlasd/routes/workspaces/schemas.ts:119:14 | error    |
| signalPathSchema                        | apps/atlasd/routes/workspaces/schemas.ts:131:14 | error    |
| createWorkspaceFromConfigResponseSchema | apps/atlasd/routes/workspaces/schemas.ts:84:14  | error    |
| workspaceDetailsResponseSchema          | apps/atlasd/routes/workspaces/schemas.ts:45:14  | error    |
| workspaceConfigResponseSchema           | apps/atlasd/routes/workspaces/schemas.ts:66:14  | error    |
| updateWorkspaceSchema                   | apps/atlasd/routes/workspaces/schemas.ts:94:14  | error    |
| workspaceIdParamSchema                  | apps/atlasd/routes/workspaces/schemas.ts:9:14   | error    |

## Unused exported types (2)

| Name           | Location                                    | Severity |
| :------------- | :------------------------------------------ | :------- |
| SessionsRoutes | apps/atlasd/routes/sessions/index.ts:118:13 | error    |
| HealthRoutes   | apps/atlasd/routes/health.ts:15:13          | error    |

## Unused exported enum members (2)

| Name    | Location                          | Severity |
| :------ | :-------------------------------- | :------- |
| Stable  | src/utils/release-channel.ts:10:3 | warn     |
| WATCHER | src/types/core.ts:146:3           | warn     |

