No Svelte config file found in /Users/ericskram/code/tempest/atlas-env/worktrees/dead-code-cleanup - using SvelteKit's default configuration without an adapter.
# Knip report

## Unused files (96)

* apps/web-client/src/lib/components/button.svelte
* apps/web-client/src/lib/components/dropzone/dropzone.svelte
* apps/web-client/src/lib/components/form/checkbox.svelte
* apps/web-client/src/lib/components/form/content.svelte
* apps/web-client/src/lib/components/form/context.ts
* apps/web-client/src/lib/components/form/field.svelte
* apps/web-client/src/lib/components/form/group.svelte
* apps/web-client/src/lib/components/form/handler.svelte
* apps/web-client/src/lib/components/form/image.svelte
* apps/web-client/src/lib/components/form/index.ts
* apps/web-client/src/lib/components/form/input.svelte
* apps/web-client/src/lib/components/form/label.svelte
* apps/web-client/src/lib/components/form/native-checkbox.svelte
* apps/web-client/src/lib/components/form/read-only.svelte
* apps/web-client/src/lib/components/form/row.svelte
* apps/web-client/src/lib/components/form/sensitive.svelte
* apps/web-client/src/lib/components/form/subheading.svelte
* apps/web-client/src/lib/components/form/textarea.svelte
* apps/web-client/src/lib/components/form/types.ts
* apps/web-client/src/lib/components/page/body.svelte
* apps/web-client/src/lib/components/safe-image.svelte
* apps/web-client/src/lib/components/segmented-control/context.svelte.ts
* apps/web-client/src/lib/components/segmented-control/index.ts
* apps/web-client/src/lib/components/segmented-control/item.svelte
* apps/web-client/src/lib/components/segmented-control/root.svelte
* apps/web-client/src/lib/components/select/button.svelte
* apps/web-client/src/lib/components/select/content.svelte
* apps/web-client/src/lib/components/select/context.ts
* apps/web-client/src/lib/components/select/hidden-input.svelte
* apps/web-client/src/lib/components/select/index.ts
* apps/web-client/src/lib/components/select/item.svelte
* apps/web-client/src/lib/components/select/label.svelte
* apps/web-client/src/lib/components/select/root.svelte
* apps/web-client/src/lib/components/select/trigger.svelte
* apps/web-client/src/lib/index.ts
* apps/web-client/src/lib/utils/index.ts
* packages/core/src/agent-context/mcp-context.ts
* packages/core/src/agent-conversion/shared/tool-converter.ts
* packages/core/src/types/index.ts
* packages/mcp-server/src/resources/workspace-creation-guide.ts
* packages/mcp-server/src/resources/workspace-reference.ts
* packages/mcp-server/src/tools/signals/describe.ts
* packages/memory/src/utils/safe-date-conversion.ts
* packages/system/agents/conversation/tools/save-env-var.ts
* packages/system/agents/conversation/tools/workspace-creation/agent-discovery-tool.ts
* packages/system/agents/conversation/tools/workspace-creation/builder.ts
* packages/system/agents/conversation/tools/workspace-creation/generation.ts
* packages/system/agents/conversation/tools/workspace-creation/generator.ts
* packages/system/agents/conversation/tools/workspace-creation/mcp-discovery-tool.ts
* packages/system/agents/conversation/tools/workspace-creation/tools.ts
* packages/system/agents/conversation/tools/workspace-update/atlas-update-workspace.ts
* packages/system/agents/conversation/tools/workspace-update/tools.ts
* packages/system/agents/conversation/tools/workspace-update/workspace-updater.ts
* packages/system/agents/workspace-creation/mod.ts
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
* src/core/agents/remote/adapters/base-remote-adapter.ts
* src/core/agents/remote/index.ts
* src/core/agents/remote/types.ts
* src/core/caching/adapters/file-cache-adapter.ts
* src/core/caching/adapters/memory-cache-adapter.ts
* src/core/caching/adapters/redis-cache-adapter.ts
* src/core/caching/supervision-cache.ts
* src/core/embedding/mock-embedding-provider.ts
* src/core/providers/state-manager.ts
* src/core/types/agent-types.ts
* src/core/utils/message-envelope.ts
* src/testing/helpers.ts
* src/tools/file-loader-tool.ts
* src/types/messages.ts
* src/types/vector-search.ts
* src/utils/errors.ts
* src/utils/memory-id-migration.ts
* src/utils/memory-migration.ts

## Unused dependencies (9)

| Name                     | Location                          | Severity |
| :----------------------- | :-------------------------------- | :------- |
| @tauri-apps/plugin-shell | apps/web-client/package.json:13:6 | error    |
| streaming-markdown       | apps/web-client/package.json:18:6 | error    |
| @atlas/workspace         | packages/system/package.json:16:6 | error    |
| @atlas/core              | packages/system/package.json:11:6 | error    |
| cookie                   | apps/web-client/package.json:15:6 | error    |
| nanoid                   | apps/web-client/package.json:17:6 | error    |
| @hono/standard-validator | package.json:31:6                 | error    |
| @tanstack/svelte-query   | package.json:42:6                 | error    |
| @biomejs/biome           | package.json:30:6                 | error    |

## Unused devDependencies (10)

| Name                        | Location                           | Severity |
| :-------------------------- | :--------------------------------- | :------- |
| electron-builder            | tools/atlas-installer/package.json | warn     |
| @rollup/rollup-darwin-arm64 | apps/web-client/package.json:29:6  | warn     |
| @sveltejs/adapter-auto      | apps/web-client/package.json:30:6  | warn     |
| svelte-adapter-deno         | apps/web-client/package.json:42:6  | warn     |
| @deno/vite-plugin           | apps/web-client/package.json:22:6  | warn     |
| svelte-preprocess           | apps/web-client/package.json:45:6  | warn     |
| @melt-ui/svelte             | apps/web-client/package.json:28:6  | warn     |
| @tauri-apps/cli             | apps/web-client/package.json:34:6  | warn     |
| svelte-check                | apps/web-client/package.json:43:6  | warn     |
| vitest                      | apps/web-client/package.json:50:6  | warn     |

## Unlisted dependencies (1)

| Name | Location                                                        | Severity |
| :-- | :-------------------------------------------------------------- | :------- |
| jsr | apps/web-client/src/lib/modules/messages/markdown-utils.test.ts | error    |

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

