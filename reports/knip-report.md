No Svelte config file found in /Users/ericskram/code/tempest/atlas-env/worktrees/more-code-cleanup - using SvelteKit's default configuration without an adapter.
# Knip report

## Unused files (66)

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

## Unused dependencies (9)

| Name                     | Location                          | Severity |
| :----------------------- | :-------------------------------- | :------- |
| @tauri-apps/plugin-shell | apps/web-client/package.json:24:6 | error    |
| streaming-markdown       | apps/web-client/package.json:29:6 | error    |
| @atlas/workspace         | packages/system/package.json:16:6 | error    |
| @atlas/core              | packages/system/package.json:11:6 | error    |
| cookie                   | apps/web-client/package.json:26:6 | error    |
| nanoid                   | apps/web-client/package.json:28:6 | error    |
| @hono/standard-validator | package.json:31:6                 | error    |
| @tanstack/svelte-query   | package.json:42:6                 | error    |
| @biomejs/biome           | package.json:30:6                 | error    |

## Unused devDependencies (8)

| Name                        | Location                           | Severity |
| :-------------------------- | :--------------------------------- | :------- |
| electron-builder            | tools/atlas-installer/package.json | warn     |
| @rollup/rollup-darwin-arm64 | apps/web-client/package.json:40:6  | warn     |
| @sveltejs/adapter-auto      | apps/web-client/package.json:41:6  | warn     |
| svelte-adapter-deno         | apps/web-client/package.json:53:6  | warn     |
| @deno/vite-plugin           | apps/web-client/package.json:33:6  | warn     |
| svelte-preprocess           | apps/web-client/package.json:56:6  | warn     |
| @melt-ui/svelte             | apps/web-client/package.json:39:6  | warn     |
| vitest                      | apps/web-client/package.json:61:6  | warn     |

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

