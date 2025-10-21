No Svelte config file found in /Users/lcf/code/github.com/tempestteam/atlas - using SvelteKit's default configuration without an adapter.
# Knip report

## Unused files (6)

* packages/mcp-server/src/tools/data-processing/csv/operations.test.ts
* packages/mcp-server/src/tools/signals/trigger.ts
* src/cli/constants/daemon-status.ts
* src/cli/constants/diagnostics-status.ts
* src/cli/utils/command-definitions.ts
* src/cli/utils/conversation-client.ts

## Unused dependencies (9)

| Name                      | Location                              | Severity |
| :------------------------ | :------------------------------------ | :------- |
| zod-from-json-schema      | packages/mcp-server/package.json:16:6 | error    |
| @ai-sdk/anthropic         | packages/mcp-server/package.json:11:6 | error    |
| @atlas/logger             | packages/signals/package.json:9:6     | error    |
| @modelcontextprotocol/sdk | package.json:36:6                     | error    |
| eventsource-client        | package.json:49:6                     | error    |
| marked-terminal           | package.json:54:6                     | error    |
| ansi-escapes              | package.json:47:6                     | error    |
| marked                    | package.json:53:6                     | error    |
| chalk                     | package.json:48:6                     | error    |

## Unlisted dependencies (1)

| Name | Location                                                        | Severity |
| :-- | :-------------------------------------------------------------- | :------- |
| npm | packages/mcp-server/src/tools/data-processing/csv/utils.ts:5:18 | error    |

## Unused exports (9)

| Name                         | Location                                                               | Severity |
| :--------------------------- | :--------------------------------------------------------------------- | :------- |
| aggregateCsv                 | packages/mcp-server/src/tools/data-processing/csv/operations.ts:464:17 | error    |
| getRowsCsv                   | packages/mcp-server/src/tools/data-processing/csv/operations.ts:495:17 | error    |
| filterCsv                    | packages/mcp-server/src/tools/data-processing/csv/operations.ts:148:17 | error    |
| sortCsv                      | packages/mcp-server/src/tools/data-processing/csv/operations.ts:198:17 | error    |
| joinCsv                      | packages/mcp-server/src/tools/data-processing/csv/operations.ts:265:17 | error    |
| buildSystemPrompt            | packages/mcp-server/src/tools/data-processing/csv/utils.ts:129:17      | error    |
| findHeaderLine               | packages/mcp-server/src/tools/data-processing/csv/utils.ts:35:17       | error    |
| parseCsvFile                 | packages/mcp-server/src/tools/data-processing/csv/utils.ts:64:23       | error    |
| linkedinProspectResearchPlan | tools/evals/agents/workspace-creation/plans/mod.ts:5:9                 | error    |

## Unused exported types (1)

| Name      | Location                                         | Severity |
| :-------- | :----------------------------------------------- | :------- |
| TableData | packages/core/src/artifacts/primitives.ts:116:13 | error    |

