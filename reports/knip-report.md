No Svelte config file found in /Users/ericskram/code/tempest/atlas-env/worktrees/knip-config - using SvelteKit's default configuration without an adapter.
# Knip report

## Unused files (107)

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
* integration-tests/fixtures/echo-mcp-server.ts
* integration-tests/fixtures/test-prompts.ts
* integration-tests/helpers/agent-execution-helpers.ts
* integration-tests/helpers/agent-server-harness.ts
* integration-tests/helpers/mcp-server-harness.ts
* integration-tests/helpers/test-registry.ts
* integration-tests/helpers/tool-call-recorder.ts
* integration-tests/helpers/workspace-helpers.ts
* integration-tests/mocks/echo-mcp-server.ts
* integration-tests/mocks/file-tools-mcp-server.ts
* integration-tests/mocks/math-mcp-server.ts
* integration-tests/mocks/mock-api-server.ts
* integration-tests/mocks/weather-mcp-server.ts
* integration-tests/remote-agents/agents.ts
* integration-tests/remote-agents/types.ts
* integration-tests/utils/mcp-test-setup.ts
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
* src/cli/components/leader-key-overlay.tsx
* src/cli/components/log-viewer.tsx
* src/cli/components/multi-select.tsx
* src/cli/components/signal-action-selection.tsx
* src/cli/modules/agents/processor.ts
* src/cli/modules/conversation/WorkspacesCommand.tsx
* src/cli/modules/conversation/utils.ts
* src/cli/modules/input/index.ts
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

## Unused exports (161)

| Name                               | Location                                                        | Severity |
| :--------------------------------- | :-------------------------------------------------------------- | :------- |
| SignalDetailsWithPath              | src/cli/modules/conversation/signal-details-with-path.tsx:11:14 | error    |
| getEnvironmentHelp                 | packages/core/src/agent-context/environment-context.ts:136:17   | error    |
| JobDetailsWithPath                 | src/cli/modules/conversation/job-details-with-path.tsx:11:14    | error    |
| createEnhancedTokenBudgetManager   | packages/memory/src/enhanced-token-budget-manager.ts:665:17     | error    |
| AgentConfigSchema                  | packages/system/agents/workspace-creation/builder.ts:31:14      | error    |
| restoreAppleTerminal               | src/cli/modules/enable-multiline/apple-terminal.ts:167:23       | error    |
| calculateDuration                  | src/cli/modules/sessions/session-list-component.tsx:48:17       | error    |
| formatDuration                     | src/cli/modules/sessions/session-list-component.tsx:29:17       | error    |
| formatTime                         | src/cli/modules/sessions/session-list-component.tsx:15:17       | error    |
| interpolateEnvironmentVariables    | packages/core/src/agent-conversion/yaml/parser.ts:101:17        | error    |
| loadYAMLAgentsFromDirectory        | packages/core/src/agent-conversion/yaml/parser.ts:123:23        | error    |
| extractMCPServerNames              | packages/core/src/agent-conversion/yaml/parser.ts:154:17        | error    |
| validateYAMLAgentFile              | packages/core/src/agent-conversion/yaml/parser.ts:225:23        | error    |
| isYAMLAgentDefinition              | packages/core/src/agent-conversion/yaml/schema.ts:139:17        | error    |
| getNormalizedToolName              | apps/web-client/src/lib/modules/messages/format.ts:84:17        | error    |
| DEFAULT_YAML_AGENT                 | packages/core/src/agent-conversion/yaml/schema.ts:144:14        | error    |
| exportJSONSchema                   | packages/core/src/agent-conversion/yaml/schema.ts:102:17        | error    |
| formatBytes                        | src/cli/modules/library/library-list-component.tsx:25:14        | error    |
| formatDate                         | src/cli/modules/library/library-list-component.tsx:33:14        | error    |
| createDaemonNotRunningError        | apps/web-client/src/lib/modules/client/daemon.ts:516:17         | error    |
| YAMLMCPServerConfigSchema          | packages/core/src/agent-conversion/yaml/schema.ts:17:14         | error    |
| YAMLLLMConfigSchema                | packages/core/src/agent-conversion/yaml/schema.ts:46:14         | error    |
| parseYAMLAgentFile                 | packages/core/src/agent-conversion/yaml/parser.ts:30:23         | error    |
| checkDaemonRunning                 | apps/web-client/src/lib/modules/client/daemon.ts:510:23         | error    |
| LibraryItemSchema                  | src/cli/modules/library/library-list-component.tsx:6:14         | error    |
| resetDaemonClient                  | apps/web-client/src/lib/modules/client/daemon.ts:505:17         | error    |
| getDaemonClient                    | apps/web-client/src/lib/modules/client/daemon.ts:497:17         | error    |
| DaemonApiError                     | apps/web-client/src/lib/modules/client/daemon.ts:484:14         | error    |
| SSEEventSchema                     | apps/web-client/src/lib/modules/messages/types.ts:77:14         | error    |
| PROVIDER_ENV_VARS                  | packages/core/src/llm-provider-registry/index.ts:65:14          | error    |
| getProviderEnvVar                  | packages/core/src/llm-provider-registry/index.ts:74:17          | error    |
| resourceReadTool                   | packages/system/agents/conversation/tools/mod.ts:39:15          | error    |
| createProviders                    | packages/core/src/llm-provider-registry/index.ts:19:17          | error    |
| todoWriteTool                      | packages/system/agents/conversation/tools/mod.ts:36:16          | error    |
| isSystemAgent                      | packages/core/src/agent-loader/adapters/types.ts:68:17          | error    |
| tableOutput                        | packages/system/agents/conversation/tools/mod.ts:38:14          | error    |
| fileOutput                         | packages/system/agents/conversation/tools/mod.ts:37:17          | error    |
| SOURCE_ATTRIBUTION_PROTOCOL_PROMPT | packages/core/src/prompts/source-attribution.ts:11:14           | error    |
| todoReadTool                       | packages/system/agents/conversation/tools/mod.ts:35:9           | error    |
| isDockerContainer                  | src/cli/modules/enable-multiline/detector.ts:290:17             | error    |
| getRouteConfig                     | apps/web-client/src/lib/app-context.svelte.ts:52:17             | error    |
| restoreGhostty                     | src/cli/modules/enable-multiline/ghostty.ts:148:23              | error    |
| createPIISafeMemoryClassifier      | packages/memory/src/pii-safe-classifier.ts:262:17               | error    |
| HALLUCINATION_PATTERNS             | src/core/services/hallucination-detector.ts:18:14               | error    |
| restoreITerm2                      | src/cli/modules/enable-multiline/iterm2.ts:134:23               | error    |
| generateBackupSuffix               | src/cli/modules/enable-multiline/utils.ts:64:17                 | error    |
| createBackup                       | src/cli/modules/enable-multiline/utils.ts:47:23                 | error    |
| createContextAssemblyService       | packages/memory/src/context-assembly.ts:575:17                  | error    |
| AgentSessionDataSchema             | packages/core/src/agent-server/types.ts:142:14                  | error    |
| workspaceRuntimeSchema             | apps/atlasd/routes/workspaces/schemas.ts:17:14                  | error    |
| checkAndDisplayUpdate              | apps/diagnostics/src/version-checker.ts:276:23                  | error    |
| createErrorResponse                | packages/mcp-server/src/prompts/types.ts:18:17                  | error    |
| setupAppleTerminal                 | src/cli/modules/enable-multiline/index.ts:5:31                  | error    |
| getEnvironmentHelp                 | packages/core/src/agent-context/index.ts:637:9                  | error    |
| checkForUpdate                     | apps/diagnostics/src/version-checker.ts:296:23                  | error    |
| setupGhostty                       | src/cli/modules/enable-multiline/index.ts:7:25                  | error    |
| setupITerm2                        | src/cli/modules/enable-multiline/index.ts:8:24                  | error    |
| loadWorkspaceConfigNoCwd           | src/cli/modules/workspaces/resolver.ts:148:23                   | error    |
| checkWorkspaceMCPEnabled           | packages/mcp-server/src/tools/utils.ts:354:23                   | error    |
| restoreAppleTerminal               | src/cli/modules/enable-multiline/index.ts:5:9                   | error    |
| calculateRetryDelay                | packages/mcp-server/src/tools/utils.ts:336:17                   | error    |
| isRetryableError                   | packages/mcp-server/src/tools/utils.ts:322:17                   | error    |
| restoreGhostty                     | src/cli/modules/enable-multiline/index.ts:7:9                   | error    |
| restoreITerm2                      | src/cli/modules/enable-multiline/index.ts:8:9                   | error    |
| sleep                              | packages/mcp-server/src/tools/utils.ts:346:17                   | error    |
| resolveWorkspaceAndConfigNoCwd     | src/cli/modules/workspaces/resolver.ts:66:23                    | error    |
| workspaceRuntimeMachineSetup       | src/core/workspace-runtime-machine.ts:128:14                    | error    |
| createMemoryKVStorage              | src/core/storage/memory-kv-storage.ts:282:23                    | error    |
| createErrorResponse                | packages/mcp-server/src/tools/types.ts:21:17                    | error    |
| YAMLFileAdapter                    | packages/core/src/agent-loader/index.ts:16:9                    | error    |
| isSystemAgent                      | packages/core/src/agent-loader/index.ts:15:9                    | error    |
| resolveWorkspaceAndConfig          | src/cli/modules/workspaces/resolver.ts:7:23                     | error    |
| libraryItemMetadataSchema          | apps/atlasd/routes/library/schemas.ts:23:14                     | error    |
| librarySearchQuerySchema           | apps/atlasd/routes/library/schemas.ts:64:14                     | error    |
| templateMetadataSchema             | apps/atlasd/routes/library/schemas.ts:94:14                     | error    |
| BundledAgentAdapter                | packages/core/src/agent-loader/index.ts:3:9                     | error    |
| SystemAgentAdapter                 | packages/core/src/agent-loader/index.ts:7:9                     | error    |
| libraryItemSchema                  | apps/atlasd/routes/library/schemas.ts:34:14                     | error    |
| IGNORE_PATTERNS                    | packages/mcp-server/src/tools/fs/ls.ts:8:14                     | error    |
| SDKAgentAdapter                    | packages/core/src/agent-loader/index.ts:4:9                     | error    |
| resolveCommand                     | src/cli/utils/command-suggestions.ts:165:17                     | error    |
| LIBRARY_FORMAT                     | apps/atlasd/routes/library/schemas.ts:17:14                     | error    |
| LIBRARY_SOURCE                     | apps/atlasd/routes/library/schemas.ts:20:14                     | error    |
| formatSessionsForJson              | src/cli/modules/sessions/fetcher.ts:101:17                      | error    |
| createDenoKVStorage                | src/core/storage/deno-kv-storage.ts:347:23                      | error    |
| LIBRARY_ITEM_TYPE                  | apps/atlasd/routes/library/schemas.ts:8:14                      | error    |
| CoALASourceMetadataSchema          | packages/memory/src/coala-memory.ts:43:14                       | error    |
| CoALAMemoryEntrySchema             | packages/memory/src/coala-memory.ts:53:14                       | error    |
| SignalDetailsWithPath              | src/cli/modules/conversation/index.ts:4:9                       | error    |
| CoALAMemoryTypeSchema              | packages/memory/src/coala-memory.ts:41:14                       | error    |
| triggerSignalSimple                | src/cli/modules/signals/trigger.ts:203:23                       | error    |
| JobDetailsWithPath                 | src/cli/modules/conversation/index.ts:2:9                       | error    |
| WorkspaceSelection                 | src/cli/modules/conversation/index.ts:6:9                       | error    |
| triggerSignal                      | src/cli/modules/signals/trigger.ts:131:23                       | error    |
| Component                          | src/cli/modules/conversation/index.ts:1:9                       | error    |
| resolveWorkspaceTargets            | src/cli/modules/signals/trigger.ts:59:23                        | error    |
| displayVersionWithRemote           | apps/diagnostics/src/version.ts:112:23                          | error    |
| SelectOption                       | src/cli/components/select/index.ts:4:9                          | error    |
| generateWorkspaceName              | src/core/utils/id-generator.ts:225:17                           | error    |
| formatVersionDisplay               | apps/diagnostics/src/version.ts:70:17                           | error    |
| DEFAULT_SSE_TIMEOUT                | packages/client/src/constants.ts:6:14                           | error    |
| resetDaemonClient                  | src/cli/utils/daemon-client.ts:490:17                           | error    |
| isValidWorkspace                   | src/cli/utils/workspace-name.ts:35:23                           | error    |
| getResourceHelp                    | src/cli/utils/resource-help.ts:304:17                           | error    |
| getAtlasVersion                    | apps/diagnostics/src/version.ts:10:17                           | error    |
| DaemonApiError                     | src/cli/utils/daemon-client.ts:469:14                           | error    |
| displayVersion                     | apps/diagnostics/src/version.ts:96:17                           | error    |
| getWorkspaceMECMFCacheDir          | apps/diagnostics/src/paths.ts:113:17                            | error    |
| getWorkspaceDiscoveryDirs          | apps/diagnostics/src/paths.ts:123:17                            | error    |
| SUPERVISION_CONFIGS                | src/core/supervision-levels.ts:29:14                            | error    |
| shouldRunValidation                | src/core/supervision-levels.ts:87:17                            | error    |
| shouldRunAnalysis                  | src/core/supervision-levels.ts:83:17                            | error    |
| getMECMFCacheDir                   | apps/diagnostics/src/paths.ts:106:17                            | error    |
| canRunParallel                     | src/core/supervision-levels.ts:95:17                            | error    |
| formatTimeout                      | src/cli/utils/daemon-status.ts:40:17                            | error    |
| formatUptime                       | src/cli/utils/daemon-status.ts:28:17                            | error    |
| resourceHelp                       | src/cli/utils/resource-help.ts:13:14                            | error    |
| canUseCache                        | src/core/supervision-levels.ts:91:17                            | error    |
| customHelp                         | src/cli/utils/help-formatter.ts:7:17                            | error    |
| getWorkspaceKnowledgeGraphDir      | apps/diagnostics/src/paths.ts:98:17                             | error    |
| getWorkspaceMemoryFilePath         | apps/diagnostics/src/paths.ts:84:17                             | error    |
| getWorkspaceMemoryDir              | apps/diagnostics/src/paths.ts:76:17                             | error    |
| getWorkspaceVectorDir              | apps/diagnostics/src/paths.ts:91:17                             | error    |
| getWorkspaceLogsDir                | apps/diagnostics/src/paths.ts:28:17                             | error    |
| getAtlasConfigDir                  | apps/diagnostics/src/paths.ts:42:17                             | error    |
| getAtlasMemoryDir                  | apps/diagnostics/src/paths.ts:68:17                             | error    |
| getAtlasCacheDir                   | apps/diagnostics/src/paths.ts:49:17                             | error    |
| getRegistryPath                    | apps/diagnostics/src/paths.ts:35:17                             | error    |
| AtlasLoggerV2                      | packages/logger/src/logger.ts:9:14                              | error    |
| healthResponseSchema               | apps/atlasd/routes/health.ts:5:14                               | error    |
| createHandler                      | apps/atlasd/src/factory.ts:57:14                                | error    |
| multiselect                        | src/cli/utils/prompts.tsx:117:14                                | error    |
| group                              | src/cli/utils/prompts.tsx:157:14                                | error    |
| intro                              | src/cli/utils/prompts.tsx:174:14                                | error    |
| outro                              | src/cli/utils/prompts.tsx:185:14                                | error    |
| note                               | src/cli/utils/prompts.tsx:209:14                                | error    |
| KVTransactionError                 | src/core/storage/index.ts:31:18                                 | error    |
| createAtlasStorage                 | src/core/storage/index.ts:64:23                                 | error    |
| KVConnectionError                  | src/core/storage/index.ts:29:19                                 | error    |
| MemoryKVStorage                    | src/core/storage/index.ts:35:32                                 | error    |
| KVStorageError                     | src/core/storage/index.ts:30:21                                 | error    |
| DenoKVStorage                      | src/core/storage/index.ts:19:30                                 | error    |
| LibraryStorageAdapter              | src/core/storage/index.ts:34:9                                  | error    |
| createMemoryKVStorage              | src/core/storage/index.ts:35:9                                  | error    |
| createDenoKVStorage                | src/core/storage/index.ts:19:9                                  | error    |
| TelemetryValidation                | src/utils/telemetry.ts:107:14                                   | error    |
| shouldDisableColor                 | src/cli/utils/output.ts:61:17                                   | error    |
| dataOutput                         | src/cli/utils/output.ts:15:17                                   | error    |
| isPiped                            | src/cli/utils/output.ts:54:17                                   | error    |
| isCompiledBinary                   | src/utils/platform.ts:89:17                                     | error    |
| formatVersionDisplay               | src/utils/version.ts:70:17                                      | error    |
| getWorkspaceMECMFCacheDir          | src/utils/paths.ts:113:17                                       | error    |
| getWorkspaceDiscoveryDirs          | src/utils/paths.ts:123:17                                       | error    |
| getWorkspaceKnowledgeGraphDir      | src/utils/paths.ts:98:17                                        | error    |
| getWorkspaceMemoryFilePath         | src/utils/paths.ts:84:17                                        | error    |
| getWorkspaceLogsDir                | src/utils/paths.ts:28:17                                        | error    |
| getAtlasConfigDir                  | src/utils/paths.ts:42:17                                        | error    |
| getAtlasMemoryDir                  | src/utils/paths.ts:68:17                                        | error    |
| getAtlasCacheDir                   | src/utils/paths.ts:49:17                                        | error    |
| getRegistryPath                    | src/utils/paths.ts:35:17                                        | error    |
| objectKeys                         | src/utils/index.ts:21:14                                        | error    |

## Unused exported types (233)

| Name                              | Location                                                                    | Severity |
| :-------------------------------- | :-------------------------------------------------------------------------- | :------- |
| WorkspaceResult                   | packages/system/agents/workspace-creation/workspace-creation.agent.ts:10:13 | error    |
| ToolExecution                     | packages/agent-sdk/src/telemetry/agent-telemetry-collector.ts:19:18         | error    |
| AgentExecutionMachineInput        | packages/core/src/agent-server/agent-execution-machine.ts:106:18            | error    |
| AgentExecutionMachine             | packages/core/src/agent-server/agent-execution-machine.ts:477:13            | error    |
| ASTNode                           | apps/web-client/src/lib/modules/messages/markdown-utils.ts:10:18            | error    |
| SendGridProviderConfig            | packages/notifications/src/providers/sendgrid-provider.ts:30:18             | error    |
| AgentExecutionContext             | packages/core/src/agent-server/agent-execution-machine.ts:72:18             | error    |
| AgentExecutionEvents              | packages/core/src/agent-server/agent-execution-machine.ts:89:13             | error    |
| BuildAgentContext                 | packages/core/src/agent-server/agent-execution-manager.ts:31:13             | error    |
| RestoreDependencies               | packages/core/src/agent-server/approval-queue-manager.ts:65:18              | error    |
| SuspendedExecution                | packages/core/src/agent-server/approval-queue-manager.ts:36:18              | error    |
| ApprovalDecision                  | packages/core/src/agent-server/approval-queue-manager.ts:53:18              | error    |
| SlackAgentResult                  | packages/bundled-agents/src/slack/slack-communicator.ts:16:13               | error    |
| EnvironmentValidationError        | packages/core/src/agent-context/environment-context.ts:12:18                | error    |
| ConversationMessage               | apps/web-client/src/lib/modules/client/conversation.ts:13:18                | error    |
| ValidatedApprovalDecision         | packages/core/src/orchestrator/agent-orchestrator.ts:126:13                 | error    |
| AwaitingApprovalResult            | packages/core/src/orchestrator/agent-orchestrator.ts:124:13                 | error    |
| CompletedAgentResult              | packages/core/src/orchestrator/agent-orchestrator.ts:123:13                 | error    |
| AgentExecutionResult              | packages/core/src/orchestrator/agent-orchestrator.ts:125:13                 | error    |
| SupervisorMemoryContext           | packages/memory/src/supervisor-memory-coordinator.ts:13:18                  | error    |
| MemoryFilteringPolicy             | packages/memory/src/supervisor-memory-coordinator.ts:19:18                  | error    |
| ValidationResult                  | packages/system/agents/workspace-creation/builder.ts:11:18                  | error    |
| AgentConfig                       | packages/system/agents/workspace-creation/builder.ts:36:13                  | error    |
| WorkspaceMemoryConfig             | packages/memory/src/workspace-memory-integration.ts:19:18                   | error    |
| FileWatchSignalConfig             | packages/signals/src/providers/fs-watch-signal.ts:25:18                     | error    |
| FileWatchSignalData               | packages/signals/src/providers/fs-watch-signal.ts:33:18                     | error    |
| YAMLMCPServerConfig               | packages/core/src/agent-conversion/yaml/schema.ts:43:13                     | error    |
| YAMLLLMConfig                     | packages/core/src/agent-conversion/yaml/schema.ts:89:13                     | error    |
| ParseOptions                      | packages/core/src/agent-conversion/yaml/parser.ts:18:18                     | error    |
| WorkspaceCreateResponse           | apps/web-client/src/lib/modules/client/daemon.ts:31:18                      | error    |
| WorkspaceCreateRequest            | apps/web-client/src/lib/modules/client/daemon.ts:24:18                      | error    |
| LibrarySearchResult               | apps/web-client/src/lib/modules/client/daemon.ts:46:18                      | error    |
| LibrarySearchQuery                | apps/web-client/src/lib/modules/client/daemon.ts:36:18                      | error    |
| TemplateConfig                    | apps/web-client/src/lib/modules/client/daemon.ts:60:18                      | error    |
| WorkspaceInfo                     | apps/web-client/src/lib/modules/client/daemon.ts:14:18                      | error    |
| LibraryStats                      | apps/web-client/src/lib/modules/client/daemon.ts:53:18                      | error    |
| DaemonClientOptions               | apps/web-client/src/lib/modules/client/daemon.ts:9:18                       | error    |
| YamlAgentResult                   | packages/core/src/agent-conversion/from-yaml.ts:23:13                       | error    |
| YamlAgent                         | packages/core/src/agent-conversion/from-yaml.ts:29:13                       | error    |
| TimerSignalPersistentState        | packages/signals/src/providers/timer-signal.ts:31:18                        | error    |
| EnhancedMemoryStatistics          | packages/memory/src/enhanced-memory-manager.ts:25:18                        | error    |
| UseTextInputStateProps            | src/cli/modules/input/use-text-input-state.ts:335:13                        | error    |
| UseSelectStateProps               | src/cli/components/select/use-select-state.ts:107:18                        | error    |
| WrappedAgent                      | packages/core/src/agent-conversion/from-llm.ts:17:13                        | error    |
| Agent                             | src/cli/modules/agents/agent-list-component.tsx:3:18                        | error    |
| K8sEventsSignalConfig             | packages/signals/src/providers/k8s-events.ts:113:18                         | error    |
| MemoryStreamType                  | packages/memory/src/streaming/memory-stream.ts:5:13                         | error    |
| HTTPRoutePattern                  | packages/signals/src/providers/http-signal.ts:17:18                         | error    |
| TokenizerConfig                   | packages/memory/src/web-embedding-provider.ts:17:18                         | error    |
| EmbeddingResult                   | packages/memory/src/web-embedding-provider.ts:34:18                         | error    |
| RouteConfig                       | apps/web-client/src/lib/app-context.svelte.ts:51:13                         | error    |
| HallucinationDetectorConfig       | src/core/services/hallucination-detector.ts:205:18                          | error    |
| SemanticFactExtractorConfig       | src/core/services/semantic-fact-extractor.ts:30:18                          | error    |
| DetectionMethodResult             | src/core/services/hallucination-detector.ts:191:18                          | error    |
| FactExtractionResult              | src/core/services/semantic-fact-extractor.ts:19:18                          | error    |
| LLMValidationResult               | src/core/services/hallucination-detector.ts:198:18                          | error    |
| FactExtractionBatch               | src/core/services/semantic-fact-extractor.ts:24:18                          | error    |
| KeyboardValue                     | apps/web-client/src/lib/app-context.svelte.ts:9:13                          | error    |
| DetectedPath                      | src/cli/modules/input/file-path-detector.ts:122:18                          | error    |
| WorkspaceSelectionState           | tools/memory_manager/types/memory-types.ts:106:18                           | error    |
| LibraryStorageConfig              | src/core/storage/library-storage-adapter.ts:28:18                           | error    |
| OptimizationResult                | packages/memory/src/token-budget-manager.ts:24:18                           | error    |
| WrappedAgentResult                | packages/core/src/agent-conversion/index.ts:38:28                           | error    |
| PromptComponents                  | packages/memory/src/token-budget-manager.ts:32:18                           | error    |
| TokenEstimate                     | packages/memory/src/token-budget-manager.ts:18:18                           | error    |
| WrappedAgent                      | packages/core/src/agent-conversion/index.ts:38:14                           | error    |
| Logger                            | packages/mcp-server/src/workspace-server.ts:13:18                           | error    |
| PIIExtractionConfig               | packages/memory/src/pii-safe-classifier.ts:18:18                            | error    |
| CoALAMemoryManager                | tools/memory_manager/types/memory-types.ts:12:32                            | error    |
| SelectOptionProps                 | src/cli/components/select/select-option.tsx:5:18                            | error    |
| CoALAMemoryEntry                  | tools/memory_manager/types/memory-types.ts:12:14                            | error    |
| LocalMemoryType                   | tools/memory_manager/types/memory-types.ts:19:13                            | error    |
| RegistryOptions                   | packages/core/src/agent-loader/registry.ts:12:18                            | error    |
| OverlayContent                    | tools/memory_manager/types/memory-types.ts:61:18                            | error    |
| EditableField                     | tools/memory_manager/types/memory-types.ts:88:13                            | error    |
| EditState                         | tools/memory_manager/types/memory-types.ts:81:18                            | error    |
| CreateWorkspaceFromConfigResponse | apps/atlasd/routes/workspaces/schemas.ts:135:13                             | error    |
| CreateWorkspaceFromConfigRequest  | apps/atlasd/routes/workspaces/schemas.ts:134:13                             | error    |
| EnvironmentValidationError        | packages/core/src/agent-context/index.ts:636:14                             | error    |
| WorkspaceDetailsResponse          | apps/atlasd/routes/workspaces/schemas.ts:132:13                             | error    |
| WorkspaceConfigResponse           | apps/atlasd/routes/workspaces/schemas.ts:133:13                             | error    |
| UpdateWorkspaceResponse           | apps/atlasd/routes/workspaces/schemas.ts:139:13                             | error    |
| UpdateWorkspaceRequest            | apps/atlasd/routes/workspaces/schemas.ts:138:13                             | error    |
| TerminalSetupState                | src/cli/modules/enable-multiline/types.ts:28:18                             | error    |
| WorkspaceResponse                 | apps/atlasd/routes/workspaces/schemas.ts:131:13                             | error    |
| ErrorResponse                     | apps/atlasd/routes/workspaces/schemas.ts:140:13                             | error    |
| ResponsiveDimensionsOptions       | src/cli/utils/useResponsiveDimensions.ts:17:18                              | error    |
| AgentContextBuilderDeps           | packages/core/src/agent-context/index.ts:19:18                              | error    |
| StateMigrationRegistry            | packages/core/src/agent-server/types.ts:105:18                              | error    |
| ClassificationResult              | packages/memory/src/memory-classifier.ts:18:18                              | error    |
| SessionManagerConfig              | packages/core/src/agent-server/types.ts:126:18                              | error    |
| TemporalMarkers                   | packages/memory/src/memory-classifier.ts:26:18                              | error    |
| ContentAnalysis                   | packages/memory/src/memory-classifier.ts:33:18                              | error    |
| StateMigration                    | packages/core/src/agent-server/types.ts:100:13                              | error    |
| UpdateInfo                        | apps/diagnostics/src/version-checker.ts:286:18                              | error    |
| StateStore                        | packages/core/src/agent-server/types.ts:112:18                              | error    |
| JeopardyValidationRequest         | src/core/services/jeopardy-validator.ts:36:18                               | error    |
| JeopardyValidatorConfig           | src/core/services/jeopardy-validator.ts:51:18                               | error    |
| ContextAssemblyOptions            | packages/memory/src/context-assembly.ts:47:18                               | error    |
| EnhancedContextPrompt             | packages/memory/src/context-assembly.ts:28:18                               | error    |
| ResponsiveDimensions              | src/cli/utils/useResponsiveDimensions.ts:7:18                               | error    |
| ValidationIssueType               | src/core/services/jeopardy-validator.ts:20:13                               | error    |
| ValidationSeverity                | src/core/services/jeopardy-validator.ts:27:13                               | error    |
| UseTextInputResult                | src/cli/modules/input/use-text-input.ts:24:13                               | error    |
| VersionCheckResult                | apps/diagnostics/src/version-checker.ts:24:18                               | error    |
| ValidationIssue                   | src/core/services/jeopardy-validator.ts:29:18                               | error    |
| VersionResponse                   | apps/diagnostics/src/version-checker.ts:11:18                               | error    |
| AgentSourceData                   | packages/core/src/agent-loader/index.ts:10:16                               | error    |
| AgentSourceType                   | packages/core/src/agent-loader/index.ts:11:19                               | error    |
| SecurityRating                    | packages/core/src/mcp-registry/types.ts:24:13                               | error    |
| AgentMCPConfig                    | packages/core/src/mcp-registry/types.ts:90:18                               | error    |
| LoaderOptions                     | packages/core/src/agent-loader/index.ts:17:27                               | error    |
| TransportType                     | packages/core/src/mcp-registry/types.ts:27:13                               | error    |
| StateMetadata                     | packages/core/src/agent-server/types.ts:77:18                               | error    |
| StateSnapshot                     | packages/core/src/agent-server/types.ts:89:18                               | error    |
| AgentSummary                      | packages/core/src/agent-loader/index.ts:12:19                               | error    |
| ToolMetadata                      | packages/core/src/mcp-registry/types.ts:33:18                               | error    |
| AgentState                        | packages/core/src/agent-server/types.ts:66:18                               | error    |
| AuthType                          | packages/core/src/mcp-registry/types.ts:30:13                               | error    |
| WorkspaceRuntimeMachine           | src/core/workspace-runtime-machine.ts:558:13                                | error    |
| GenerateFromTemplate              | apps/atlasd/routes/library/schemas.ts:173:13                                | error    |
| LibrarySearchResult               | apps/atlasd/routes/library/schemas.ts:170:13                                | error    |
| UseTextInputProps                 | src/cli/modules/input/use-text-input.ts:7:13                                | error    |
| CreateLibraryItem                 | apps/atlasd/routes/library/schemas.ts:168:13                                | error    |
| WorkspaceRuntime                  | packages/client/src/types/workspace.ts:27:18                                | error    |
| UseSelectProps                    | src/cli/components/select/use-select.ts:4:18                                | error    |
| TemplateConfig                    | apps/atlasd/routes/library/schemas.ts:172:13                                | error    |
| AgentAdapter                      | packages/core/src/agent-loader/index.ts:9:14                                | error    |
| LibraryStats                      | apps/atlasd/routes/library/schemas.ts:171:13                                | error    |
| SectionType                       | packages/memory/src/context-assembly.ts:7:13                                | error    |
| LibraryItem                       | apps/atlasd/routes/library/schemas.ts:167:13                                | error    |
| WorkspaceRuntimeContext           | src/core/workspace-runtime-machine.ts:43:18                                 | error    |
| WorkspaceRuntimeEvent             | src/core/workspace-runtime-machine.ts:78:13                                 | error    |
| SignalTriggerResponse             | apps/atlasd/routes/signals/schemas.ts:34:13                                 | error    |
| EmergencyPruneResult              | packages/memory/src/error-handling.ts:50:18                                 | error    |
| ConversationEntry                 | src/cli/modules/conversation/types.ts:43:18                                 | error    |
| ResourceMetrics                   | packages/memory/src/error-handling.ts:42:18                                 | error    |
| CommandContext                    | src/cli/modules/conversation/types.ts:25:18                                 | error    |
| ErrorStatistic                    | packages/memory/src/error-handling.ts:18:18                                 | error    |
| FallbackResult                    | packages/memory/src/error-handling.ts:34:18                                 | error    |
| ParsedCommand                     | src/cli/modules/conversation/types.ts:37:18                                 | error    |
| ErrorResponse                     | apps/atlasd/routes/signals/schemas.ts:35:13                                 | error    |
| ErrorDetails                      | packages/memory/src/error-handling.ts:10:18                                 | error    |
| ErrorContext                      | packages/memory/src/error-handling.ts:25:18                                 | error    |
| GenerateFromTemplateRequest       | packages/client/src/types/library.ts:67:18                                  | error    |
| ConversationMessage               | src/cli/utils/conversation-client.ts:14:18                                  | error    |
| CommandInputProps                 | src/cli/components/command-input.tsx:11:18                                  | error    |
| SessionFetchResponse              | src/cli/modules/sessions/fetcher.ts:21:13                                   | error    |
| ConversationSession               | src/cli/utils/conversation-client.ts:7:18                                   | error    |
| SessionFetchError                 | src/cli/modules/sessions/fetcher.ts:15:18                                   | error    |
| CommandDefinition                 | src/cli/utils/command-definitions.ts:1:18                                   | error    |
| TextInputProps                    | src/cli/modules/input/text-input.tsx:7:13                                   | error    |
| CommandInfo                       | src/cli/utils/command-suggestions.ts:3:18                                   | error    |
| SelectProps                       | src/cli/components/select/select.tsx:9:18                                   | error    |
| GenerateFromTemplateRequest       | packages/client/src/types/index.ts:15:29                                    | error    |
| LibraryFetchResponse              | src/cli/modules/library/fetcher.ts:24:13                                    | error    |
| SessionFetchOptions               | src/cli/modules/sessions/fetcher.ts:4:18                                    | error    |
| TriggerSignalResult               | src/cli/modules/signals/trigger.ts:10:18                                    | error    |
| BatchTriggerOptions               | src/cli/modules/signals/trigger.ts:25:18                                    | error    |
| LibraryFetchResult                | src/cli/modules/library/fetcher.ts:13:18                                    | error    |
| SessionFetchResult                | src/cli/modules/sessions/fetcher.ts:9:18                                    | error    |
| BatchTriggerResult                | src/cli/modules/signals/trigger.ts:33:18                                    | error    |
| LibraryFetchError                 | src/cli/modules/library/fetcher.ts:18:18                                    | error    |
| StatusBadgeProps                  | src/cli/components/status-badge.tsx:4:18                                    | error    |
| WorkspaceRuntime                  | packages/client/src/types/index.ts:47:17                                    | error    |
| WorkspaceTarget                   | src/cli/modules/signals/trigger.ts:20:18                                    | error    |
| SignalInfo                        | packages/client/src/types/index.ts:33:22                                    | error    |
| SignalInfo                        | packages/client/src/types/signal.ts:5:18                                    | error    |
| TriggerSignalOptions              | src/cli/modules/signals/trigger.ts:4:18                                     | error    |
| LibraryFetchOptions               | src/cli/modules/library/fetcher.ts:4:18                                     | error    |
| SelectOptionProps                 | src/cli/components/select/index.ts:3:14                                     | error    |
| SelectProps                       | src/cli/components/select/index.ts:1:14                                     | error    |
| Option                            | src/cli/components/select/index.ts:5:14                                     | error    |
| Theme                             | src/cli/components/select/theme.ts:3:18                                     | error    |
| Key                               | src/cli/modules/input/key-press.ts:7:18                                     | error    |
| ExponentialBackoffOptions         | src/utils/exponential-backoff.ts:5:18                                       | error    |
| DaemonExecutionContext            | src/core/daemon-capabilities.ts:19:18                                       | error    |
| DaemonCapability                  | src/core/daemon-capabilities.ts:10:18                                       | error    |
| KVStorageConfig                   | src/core/storage/kv-storage.ts:134:18                                       | error    |
| WorkspaceCreateResponse           | src/cli/utils/daemon-client.ts:29:18                                        | error    |
| WorkspaceCreateRequest            | src/cli/utils/daemon-client.ts:22:18                                        | error    |
| LibrarySearchResult               | src/cli/utils/daemon-client.ts:63:18                                        | error    |
| LibrarySearchQuery                | src/cli/utils/daemon-client.ts:34:18                                        | error    |
| SupervisionConfig                 | src/core/supervision-levels.ts:12:18                                        | error    |
| TemplateConfig                    | src/cli/utils/daemon-client.ts:77:18                                        | error    |
| WorkspaceInfo                     | src/cli/utils/daemon-client.ts:12:18                                        | error    |
| LibraryStats                      | src/cli/utils/daemon-client.ts:70:18                                        | error    |
| DaemonStatus                      | src/cli/utils/daemon-status.ts:20:18                                        | error    |
| LibraryItem                       | src/cli/utils/daemon-client.ts:44:18                                        | error    |
| WorkspaceRuntimeOptions           | src/core/workspace-runtime.ts:18:18                                         | error    |
| DaemonClientOptions               | src/cli/utils/daemon-client.ts:7:18                                         | error    |
| ResourceHelp                      | src/cli/utils/resource-help.ts:5:18                                         | error    |
| UpdateInfo                        | src/utils/version-checker.ts:286:18                                         | error    |
| TokenizationOptions               | src/utils/prompt-tokenizer.ts:7:18                                          | error    |
| VersionCheckResult                | src/utils/version-checker.ts:24:18                                          | error    |
| VersionResponse                   | src/utils/version-checker.ts:11:18                                          | error    |
| TableProps                        | src/cli/components/table.tsx:12:18                                          | error    |
| ProviderCredentials               | src/core/providers/types.ts:44:18                                           | error    |
| ISignalProvider                   | src/core/providers/types.ts:57:18                                           | error    |
| IProviderSignal                   | src/core/providers/types.ts:69:18                                           | error    |
| ProviderStatus                    | src/core/providers/types.ts:36:13                                           | error    |
| IAgentProvider                    | src/core/providers/types.ts:62:18                                           | error    |
| ProviderState                     | src/core/providers/types.ts:28:18                                           | error    |
| FollowOptions                     | src/cli/utils/log-reader.ts:15:18                                           | error    |
| HealthStatus                      | src/core/providers/types.ts:50:18                                           | error    |
| ReadOptions                       | src/cli/utils/log-reader.ts:10:18                                           | error    |
| Column                            | src/cli/components/table.tsx:4:18                                           | error    |
| TemplateEngineRegistry            | src/core/library/types.ts:135:18                                            | error    |
| LibraryIndexItem                  | src/core/library/types.ts:109:18                                            | error    |
| ITemplateEngine                   | src/core/library/types.ts:128:18                                            | error    |
| ILibraryStorage                   | src/core/library/types.ts:143:18                                            | error    |
| LogFilters                        | src/cli/utils/log-reader.ts:4:18                                            | error    |
| MemoryRetentionConfig             | src/core/memory-config.ts:34:18                                             | error    |
| LibraryStorageConfig              | src/core/library/types.ts:90:18                                             | error    |
| LibraryStorageConfig              | src/core/storage/index.ts:34:37                                             | error    |
| MemoryConfiguration               | src/core/memory-config.ts:26:18                                             | error    |
| AtlasMemoryConfig                 | src/core/memory-config.ts:40:18                                             | error    |
| MemoryTypeConfig                  | src/core/memory-config.ts:19:18                                             | error    |
| TemplateMetadata                  | src/core/library/types.ts:57:18                                             | error    |
| ValidationResult                  | src/core/library/types.ts:84:18                                             | error    |
| AtomicOperation                   | src/core/storage/index.ts:21:14                                             | error    |
| KVStorageConfig                   | src/core/storage/index.ts:24:13                                             | error    |
| MemoryLimits                      | src/core/memory-config.ts:13:18                                             | error    |
| LibraryIndex                      | src/core/library/types.ts:99:18                                             | error    |
| SelectOption                      | src/cli/utils/prompts.tsx:14:18                                             | error    |
| WatchEvent                        | src/core/storage/index.ts:25:19                                             | error    |
| KVStorage                         | src/core/storage/index.ts:23:11                                             | error    |
| KVEntry                           | src/core/storage/index.ts:22:19                                             | error    |
| PromptOptions                     | src/cli/utils/prompts.tsx:7:18                                              | error    |
| PortFinderOptions                 | src/utils/port-finder.ts:7:18                                               | error    |
| SystemdServiceConfig              | src/services/types.ts:66:18                                                 | error    |
| WindowsServiceConfig              | src/services/types.ts:79:18                                                 | error    |
| ObjectEntry                       | src/utils/index.ts:33:13                                                    | error    |

## Unused exported enum members (4)

| Name     | Location                                     | Severity |
| :------- | :------------------------------------------- | :------- |
| WORKFLOW | packages/signals/src/providers/types.ts:23:3 | warn     |
| SOURCE   | packages/signals/src/providers/types.ts:24:3 | warn     |
| ACTION   | packages/signals/src/providers/types.ts:25:3 | warn     |
| WATCHER  | src/types/core.ts:145:3                      | warn     |

