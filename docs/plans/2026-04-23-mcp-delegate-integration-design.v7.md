<!-- v7 - 2026-04-23 - Generated via /improving-plans from docs/plans/2026-04-23-mcp-delegate-integration-design.v6.md -->

# MCP-Delegate Integration

## Problem Statement

As a Friday user, when I ask the workspace chat agent to do something that
requires an external integration — e.g., "what were my last few rides on strava"
— the agent has no path to leverage MCP servers I've installed from the
registry. The `delegate` tool spawns a sub-agent with the parent's tool set, but
the parent has zero MCP tools. Registry-imported servers sit in the storage
adapter, invisible to the workspace chat agent. Bundled agents (via the
FSM/direct-executor path) get MCP tools through `fetchAllTools()`, but workspace
chat — the primary user-facing interface — does not.

Even if we wired MCP tools into workspace chat, exposing all 30+ potential
servers to every sub-agent is untenable: token bloat in tool descriptions,
credential failures on unconfigured servers, and tool name collisions across
servers. The agent needs a principled way to discover which servers are
available, select the relevant ones for a task, and hand them to a delegated
sub-agent — without inventing servers, choosing unconfigured ones, or drowning
in noise.

## Solution

Add MCP server awareness to the workspace chat agent through three mechanisms:

1. **A `list_mcp_servers` tool** that the parent calls on-demand to discover
   configured (credential-resolved) servers with their descriptions,
   constraints, status, and — for unconfigured servers — the exact credentials
   they need. No system prompt bloat.

2. **LLM-driven server selection via the `delegate` tool.** The parent LLM calls
   `list_mcp_servers`, reads the available servers, and passes the relevant
   server IDs in the `mcpServers` field of the delegate input. The `delegate`
   tool description is mutated per-turn to instruct the LLM to call
   `list_mcp_servers` first. Server-side validation rejects unknown or
   unconfigured IDs immediately with a clear error.

3. **Conditional tool name prefixing** (`strava_getActivity`,
   `github_searchIssues`) when multiple MCP servers are merged into the child's
   tool set and their tool names collide. Single-server delegates get unprefixed
   names. This eliminates collisions when they occur and keeps names clean in
   the common case.

The parent sees registry-imported servers the same way it sees bundled agents:
available when configured, absent when not. The child inherits a curated subset
of MCP tools selected for its task. On credential failure, the child degrades
gracefully — dropping the failed server and continuing with the subset, or
returning a structured reason if all fail. The parent LLM receives enough
per-server failure signal to surface actionable messages like "Strava needs
STRAVA_ACCESS_TOKEN — want to configure it?"

## User Stories

1. As a Friday user, I want the workspace chat agent to know about MCP servers
   I've installed from the registry, so that I can ask natural-language
   questions that require them.

2. As a Friday user, I want the agent to only attempt connections to servers
   that are actually configured with credentials, so that I don't see repeated
   "missing token" errors.

3. As a Friday user, when I ask about Strava rides, I want the agent to find the
   Strava MCP server via `list_mcp_servers`, select it explicitly, and pass it
   to `delegate` — or tell me it's not configured if I haven't set it up.

4. As a Friday user, I want to see which MCP servers the agent considered for a
   delegated task, so that I understand its reasoning and can debug wrong
   selections.

5. As a Friday user, I want tool names from different MCP servers to be
   distinguishable when both servers are in use, so that I can tell whether
   `search_repositories` came from GitHub or GitLab.

6. As a Friday user, I want a delegated sub-agent to keep working even if one of
   several MCP servers fails to connect, so that partial failures don't kill the
   whole task.

7. As a Friday user, when I ask "what MCP servers do I have?", I want the agent
   to tell me which ones need credentials and guide me to connect them via
   `connect_service`, so that I can configure them without leaving the chat.

8. As a Friday developer, I want MCP server discovery to be a tool call (not
   system prompt injection), so that token costs stay bounded regardless of how
   many servers the user has installed.

9. As a Friday developer, I want credential resolution pre-checking to use the
   already-fetched Link summary, so that the common "no credentials set" case is
   detected accurately without extra API calls.

10. As a Friday developer, I want registry-imported MCP servers to be treated
    identically to static blessed servers in terms of tool wiring, so that
    there's no special-casing between "built-in" and "installed" servers.

11. As a Friday developer, I want failed MCP connections inside a delegate to
    produce structured errors per server, so that the parent can surface
    actionable messages like "Strava needs STRAVA_ACCESS_TOKEN — want to
    configure it?"

12. As a Friday engineer, I want tool name prefixing to happen only when
    multiple MCP servers are in the same delegate call and their tools collide,
    so that single-server delegates preserve original tool names for cleaner LLM
    comprehension.

13. As a Friday engineer, I want the workspace chat's tool set construction to
    follow the same `primaryTools` + `composeTools` pattern as bundled agents,
    so that the architecture remains consistent.

14. As a Friday engineer, I want workspace-configured MCP servers
    (`tools.mcp.servers` in workspace.yml) to be discoverable and routable the
    same way as static and registry-imported servers, so that custom servers
    aren't second-class.

15. As a Friday user, I want my custom workspace-configured MCP servers to show
    meaningful descriptions in `list_mcp_servers` results, so that I understand
    what they do without consulting the source code.

16. As a Friday developer, I want the parent LLM to be the one selecting MCP
    servers for delegation, not a hidden routing layer, so that the selection is
    transparent, debuggable, and leverages the LLM's full conversation context.

17. As a Friday developer, I want the MCP registry import route to automatically
    create a corresponding Link provider for every imported server, so that
    `connect_service` is the universal credential setup tool and
    registry-imported servers work out of the box without manual Link provider
    configuration.

## Implementation Decisions

### Modules affected

- **`packages/system/agents/workspace-chat/workspace-chat.agent.ts`** —
  registers `list_mcp_servers` tool in `primaryTools`; adds a system prompt
  clause informing the LLM that external integrations are available via MCP
  servers and can be discovered with `list_mcp_servers`, then passed to
  `delegate` via the `mcpServers` field; adds a system prompt clause instructing
  the LLM to automatically continue with `delegate` when it receives a
  `data-credential-linked` event for an MCP provider it previously asked the
  user to connect; passes `workspaceConfig` and `linkSummary` to
  `createDelegateTool` and `createListMcpServersTool` to avoid redundant
  fetches.
- **`packages/system/agents/conversation/tools/delegate/index.ts`** — adds
  `mcpServers?: string[]` to `DelegateInputSchema`; mutates the delegate tool
  description per-turn to instruct the LLM to call `list_mcp_servers` first and
  pass relevant IDs; adds server-side validation of provided IDs against the
  discovery result (unknown or unconfigured → `ok: false`); adds
  credential-configured server filtering; adds conditional tool name prefixing
  during child tool-set construction; adds per-server `createMCPTools` calls
  wrapped in `Promise.allSettled` for graceful degradation (the current
  `createMCPTools` API throws on first failure when given multiple servers, so
  each selected server is wrapped individually); collects `dispose()` callbacks
  from each successful per-server `createMCPTools` call and invokes them via
  `Promise.allSettled` in the `finally` block before `proxy.close()`, preventing
  stdio process and HTTP transport leaks; runs `injectSlackAppCredentialId` on
  selected server configs before connecting to resolve slack-app Link refs;
  augments failure result with `serverFailures`; accepts `workspaceConfig` and
  `linkSummary` in `DelegateDeps` to avoid redundant fetches.
- **`packages/core/src/mcp-registry/discovery.ts`** (new) — shared
  `discoverMCPServers()` that merges static registry + storage adapter entries +
  workspace-configured servers, applies workspace overrides onto metadata
  `configTemplate`, checks credentials via `linkSummary` (for Link-backed
  servers) or `process.env` (for workspace-configured string env vars), and
  returns enriched candidates. Consumed by both `list_mcp_servers` and delegate
  tool description generation + validation.
- **`packages/core/src/mcp-registry/credential-resolver.ts`** — no changes
  required; `resolveEnvValues()` handles Link credential fetching at connection
  time as before.
- **`packages/mcp/src/create-mcp-tools.ts`** — adds optional `toolPrefix`
  parameter to `createMCPTools` (or a wrapper that prefixes tool names during
  merge). Used when multiple servers are selected and collision is possible.
- **`packages/core/src/agent-context/index.ts`** — refactored to consume
  `discoverMCPServers()` for its own server enumeration, eliminating the
  duplication between `fetchAllTools` and the new delegate path.
- **`packages/agent-sdk/src/types.ts`** — adds optional `description?: string`
  field to `MCPServerConfigSchema` so workspace-only servers can carry
  meaningful metadata for `list_mcp_servers` and routing prompts.

### Architectural decisions

- **Unified server discovery via `discoverMCPServers()`.** A single async
  function (it reads `process.env`, the storage adapter, and the Link summary)
  produces the canonical list of available MCP servers for a workspace. It:
  1. Enumerates static blessed servers from `mcpServersRegistry.servers`.
  2. Enumerates registry-imported servers from `getMCPRegistryAdapter().list()`.
  3. Reads workspace-configured servers from `workspaceConfig.tools.mcp.servers`
     (if workspace config is available).
  4. Merges workspace config overrides into each matching server's
     `configTemplate` (workspace `transport` and `env` win over metadata
     defaults; servers defined only in workspace config appear with
     `source: "workspace"` and metadata derived from the config, including the
     optional `description` field).
  5. Checks credentials:
     - For **Link-backed env vars** (`{ from: "link", provider: id, ... }`):
       checks `linkSummary.credentials` for a credential matching the provider
       ID. `configured: true` if at least one credential exists (or exactly one,
       or one marked `isDefault`).
     - For **string env vars** (workspace-configured only): checks `process.env`
       for presence and not a `<placeholder>` pattern. This is the fallback for
       custom servers that don't use Link.
  6. Returns `Array<{ metadata, mergedConfig, configured }>`.

  Both `list_mcp_servers` and delegate tool description generation + validation
  consume this list. This guarantees they see the exact same universe and that
  workspace overrides are never silently ignored. Server count is capped at 50.

  `discoverMCPServers()` accepts `linkSummary` as an optional parameter (already
  fetched by the workspace-chat handler). If not provided, it fetches
  internally. If workspace config is unavailable (not passed by the caller and
  the daemon fetch fails), it throws. Callers handle this: `list_mcp_servers`
  propagates the error to the LLM as a tool error; `delegate.execute()` catches
  it and returns `ok: false`.

- **LLM-driven server selection via `mcpServers` field.** The `delegate` tool's
  input schema gains an optional `mcpServers: z.array(z.string())` field. The
  parent LLM is responsible for calling `list_mcp_servers`, understanding what's
  available and configured, then passing the relevant IDs to `delegate`. There
  is no automatic routing inside `delegate.execute()`. The parent LLM's full
  conversation context, user intent, and understanding of connectedness drives
  the selection.

- **Per-turn delegate tool description mutation.** `createDelegateTool` receives
  the discovery result (or at least a signal that servers exist) and embeds an
  instruction in the tool description:

  > "Spawn a sub-agent that runs in-process and inherits all of your tools
  > (except delegate itself). Use for arbitrary multi-step work that doesn't map
  > to a more specific tool. To include MCP server tools in the sub-agent, first
  > call `list_mcp_servers` to discover available servers and their
  > configuration status, then pass the relevant server IDs in the `mcpServers`
  > field. Provide a clear goal and a distilled handoff summary — the sub-agent
  > does NOT see your conversation history."

  No server IDs are enumerated in the description. The LLM must call
  `list_mcp_servers` to learn what's available, preventing assumptions based on
  stale or incomplete name lists.

- **Fail-fast validation of `mcpServers` IDs.** `delegate.execute()` validates
  each ID in the `mcpServers` array against the discovery result (the same
  result used by `list_mcp_servers`). Unknown IDs or IDs with
  `configured: false` cause an immediate return of
  `{ ok: false, reason: "Invalid MCP server ID: 'foo' not found or not configured" }`.
  This gives the LLM clear signal to re-check `list_mcp_servers` and retry.

- **Graceful degradation on connection failure.** `delegate.execute()` calls
  `createMCPTools` individually for each validated selected server (each wrapped
  in its own `{ [serverId]: config }` record), collecting all calls in
  `Promise.allSettled`. Servers that fail credential resolution or connection
  are dropped, with their failure reason logged. If at least one server
  connects, the child proceeds with the subset. If **all selected servers
  fail**, `delegate` returns `ok: false` with a human-readable `reason` and a
  `serverFailures` array mapping each failed server's ID to its failure reason.
  The parent LLM can surface these to the user.

- **Per-server MCP connection disposal.** Each successful per-server
  `createMCPTools` call returns a `dispose()` callback. These callbacks are
  collected in an array during `delegate.execute()` and invoked in the `finally`
  block via `Promise.allSettled` before `proxy.close()`. Failed server
  connections (rejected `Promise.allSettled` entries) have no dispose callback
  and are skipped. This prevents stdio subprocess and HTTP transport leaks.

- **Conditional tool name prefixing.** When `delegate.execute()` selects exactly
  one MCP server, the child's MCP tools are NOT prefixed — they retain their
  original names (e.g., `getActivity`, `searchIssues`). When 2+ servers are
  selected, all MCP tools from all selected servers are prefixed with
  `{serverId}_` (e.g., `strava-mcp_getActivity`, `github_searchIssues`). The
  prefix check happens after `createMCPTools` returns: if there are any key
  collisions across the merged tool maps, prefixing is applied to all MCP tools.
  If no collisions exist, prefixing is still applied for consistency (the child
  LLM sees uniform naming when multiple servers are in play). The `delegate`
  ledger records the prefixed name so the UI and reflection can disambiguate.

- **No auto-routing LLM call.** The v5-v6 design used `generateObject` with the
  `labels` model for automatic server selection. This is removed entirely. There
  is no routing prompt, no `generateObject` dependency, no `labels` model
  requirement, and no `assertStructuredOutputSupport` startup assertion. The
  parent LLM is the router.

- **On-demand discovery via tool, not prompt injection.** Registry-imported
  servers are not injected into the system prompt. The `list_mcp_servers` tool
  returns them with descriptions, constraints, `configured` status, and
  `requiredConfig` for unconfigured servers. In workspace chat, the legacy
  `<mcp_servers>` tag from `mcpServerNames()` is removed — `list_mcp_servers`
  replaces it as the single discovery mechanism. Static blessed servers continue
  to appear in `getCapabilitiesSection()` for bundled agents, which is
  unchanged.

- **Async credential validation via Link summary.** For registry-imported and
  blessed servers (which use Link refs for credentials), `discoverMCPServers()`
  checks the Link summary (already fetched at turn start by the workspace-chat
  handler). A server is `configured: true` if `linkSummary.credentials` contains
  at least one entry for the server's provider ID. For workspace-configured
  servers with string env vars (not Link refs), `process.env` is checked
  synchronously as a fallback. This eliminates the false-positive
  `configured: true` for Link-backed servers with expired/missing credentials,
  without adding per-server HTTP calls.

- **Static + registry + workspace server parity.** All three sources flow
  through the same code path: `discoverMCPServers()` → metadata + mergedConfig →
  credential check → validation → conditional prefixing → child tool set. No
  special casing based on `source: "static"` vs `"registry"` vs `"workspace"`.

- **`list_mcp_servers` returns `provider` for unconfigured Link-backed
  servers.** When `configured: false` and the server uses Link authentication,
  the tool response includes `provider: string` (the Link provider ID, same as
  the server ID). This cues the LLM to call `connect_service(provider: id)` to
  set up the credential. For workspace-configured servers with string env vars,
  `requiredConfig` is included so the LLM can tell the user which env var to
  set. When `configured: true`, both fields are omitted.

- **Workspace-only servers support an optional `description` field.** The
  `MCPServerConfigSchema` in `packages/agent-sdk/src/types.ts` adds an optional
  `description?: string` field. When a server is defined only in workspace.yml,
  `discoverMCPServers()` reads this field to populate `metadata.description` for
  the `list_mcp_servers` output. This ensures custom servers aren't listed with
  empty descriptions. Existing workspace.yml files without `description`
  continue to work with empty descriptions.

- **Slack-app credential resolution in delegate path.** Before connecting
  selected servers, `delegate.execute()` applies slack-app credential resolution
  to any selected server configs that contain a `provider: "slack-app"` Link ref
  without an explicit `id`. This mirrors the existing `fetchAllTools` behavior
  and ensures workspace-wired Slack bots are correctly resolved in the delegate
  path.

- **`workspaceConfig` and `linkSummary` passed through `DelegateDeps`.** The
  workspace chat handler already fetches workspace config (line ~534) and Link
  summary (line ~550) in parallel at turn start. Both are threaded through
  `DelegateDeps` to `createDelegateTool` and `createListMcpServersTool`,
  eliminating redundant fetches inside `delegate.execute()` and
  `list_mcp_servers`.

- **Registry import must auto-create Link providers (prerequisite, NOT YET
  IMPLEMENTED).** The MCP registry import route
  (`POST /api/mcp-registry/install`, per
  `docs/plans/2026-04-22-mcp-registry-import-design.v4.md`) must be updated to
  automatically create a Link provider for every imported server. The translator
  maps upstream `environmentVariables` to a Link provider's secret schema, and
  `remotes` without env vars to an OAuth provider. This ensures every
  registry-imported server has a corresponding Link provider ID (same as the
  server ID), making `connect_service` the universal credential setup tool. No
  manual env var configuration is needed for registry-imported servers. **This
  is a blocking prerequisite for the v7 plan — without it, registry-imported
  servers have no Link provider and `connect_service` cannot be used to set up
  their credentials.**

  **Current state:** The registry import route
  (`apps/atlasd/routes/mcp-registry.ts`) fetches upstream data, calls
  `translate()` to produce `MCPServerMetadata`, and stores it via
  `getMCPRegistryAdapter().add(entry)`. It does NOT create a Link provider. The
  translator produces `configTemplate.env` with placeholder strings (e.g.,
  `<STRIPE_API_KEY>`) but no Link provider input.

  **What needs to change:**
  1. `packages/core/src/mcp-registry/translator.ts` — The `translate()` function
     must also produce a `DynamicProviderInput` for Link alongside the
     `MCPServerMetadata`:
     - **npm+stdio with env vars** → `DynamicApiKeyProviderInput` where
       `secretSchema` maps each env var name to `"string"`, and `id` matches the
       server ID.
     - **http remote without env vars** → `DynamicOAuthProviderInput` with
       `mode: "discovery"` and `serverUrl` set to the resolved HTTP URL.
     - **http remote with env vars** → `DynamicApiKeyProviderInput` (env vars
       become API key fields, consistent with the translator's current transport
       precedence).
  2. `apps/atlasd/routes/mcp-registry.ts` — The `/install` route must, after
     successful `adapter.add(entry)`, call `POST /api/link/v1/providers` with
     the `DynamicProviderInput` from the translator. The provider ID is the same
     as the MCP server ID. If Link provider creation fails, the install should
     be considered a partial failure — the MCP metadata is stored but the user
     cannot connect credentials until the Link provider is created. Options: (a)
     roll back the registry entry, (b) return 201 with a warning, (c) retry the
     Link creation. The safest is (b) — return the stored server with a warning
     that credential setup is pending.
  3. The translator's `TranslateResult` type gains a
     `linkProvider?: DynamicProviderInput` field. The install route consumes
     this field to create the Link provider.
  4. Registry-imported server metadata (`MCPServerMetadata`) must set
     `configTemplate.env` to use Link refs
     (`{ from: "link", provider: id, key: "..." }`) instead of placeholder
     strings, so that `resolveEnvValues()` fetches credentials from Link at
     connection time. This replaces the current placeholder-string approach.

  **Files changed:**
  - `packages/core/src/mcp-registry/translator.ts` — add `linkProvider` to
    `TranslateResult`, build `DynamicProviderInput` from upstream data
  - `packages/core/src/mcp-registry/translator.test.ts` — test Link provider
    input generation for all three cases
  - `apps/atlasd/routes/mcp-registry.ts` — add Link
    `POST /api/link/v1/providers` call after `adapter.add(entry)`
  - `apps/atlasd/routes/mcp-registry.test.ts` — test install route with Link
    provider creation (success and failure)

  **Coordination note:** This prerequisite can be developed independently of the
  v7 delegate/chat changes, but both must land before registry-imported servers
  are usable end-to-end. The blessed servers (static registry) already use Link
  refs and don't need this change.

### Module Boundaries

**`discoverMCPServers(workspaceId, workspaceConfig?, linkSummary?)`**

- _Interface:_ Returns `Promise<Array<MCPServerCandidate>>` where each candidate
  carries `metadata: MCPServerMetadata`, `mergedConfig: MCPServerConfig`, and
  `configured: boolean`. Server count is capped at 50.
- _Hides:_ the distinction between static registry, storage adapter, and
  workspace config; workspace override merge logic (transport and env); the dual
  credential check path (Link summary for registry/blessed, `process.env` for
  workspace-configured); the 50-server cap.
- _Trust contract:_ every returned candidate is a real server that can be passed
  to `createMCPTools` (with the merged config). `configured: true` means: (a)
  for Link-backed servers, at least one credential exists in Link for the
  provider ID; (b) for string env vars, the env var is present in `process.env`
  and not a placeholder. `configured: false` means the credential is missing
  (Link has none, or env var is absent/placeholder). Workspace overrides are
  applied before credential checks. The list is complete: all static + all
  stored + all workspace-configured entries (capped at 50).
- _Error contract:_ throws if workspace config is needed (not passed by caller
  and daemon fetch fails). Callers must handle this — `list_mcp_servers`
  surfaces it as a tool error; `delegate.execute()` catches it and returns
  `ok: false`.

**`list_mcp_servers` tool**

- _Interface:_ No input. Returns
  `{ servers: Array<{ id, name, description, constraints?, configured, securityRating, source, provider?, requiredConfig? }> }`.
- _Hides:_ the shared discovery module; the dual credential check path (Link vs
  `process.env`).
- _Trust contract:_ every returned server with `configured: true` has a valid
  credential (Link credential exists, or `process.env` has the env var).
  `configured: false` means the credential is missing. `provider` is present
  when `configured: false` and the server uses Link auth (so the LLM can call
  `connect_service`). `requiredConfig` is present when `configured: false` and
  the server uses string env vars. The list is complete for the workspace.
- _Error contract:_ if `discoverMCPServers()` throws (workspace config fetch
  failure), the tool execution fails and the error is surfaced to the LLM.

**`delegate` tool (with `mcpServers` field)**

- _Interface:_ Input:
  `{ goal: string, handoff: string, mcpServers?: string[] }`. Tool description
  is mutated per-turn to instruct the LLM to call `list_mcp_servers` first.
  Returns `DelegateResult` (success or failure with `serverFailures` array).
- _Hides:_ the discovery result used for validation; per-server `createMCPTools`
  calls and `Promise.allSettled` collection; conditional prefixing logic;
  per-server disposal collection; slack-app credential injection.
- _Trust contract:_ every ID in `mcpServers` is validated against the discovery
  result. Unknown or unconfigured IDs → `ok: false` with a clear reason. Valid
  IDs → per-server connection with graceful degradation. At least one successful
  connection → child proceeds. All fail → `ok: false` with `serverFailures`.
  Tool names are prefixed when 2+ servers are present, unprefixed when 1. All
  MCP connections are disposed in `finally`.
- _Error contract:_ if `discoverMCPServers()` throws (not passed and fetch
  fails), returns `ok: false` with the error reason. If all selected servers
  fail connection, returns `ok: false` with `serverFailures`. Invalid IDs fail
  fast before any connection attempt.

**Credential checker (internal to `discoverMCPServers`)**

- _Interface:_ For Link-backed servers:
  `hasLinkCredential(linkSummary, providerId): boolean`. For string env vars:
  `hasResolvedEnvVar(envKey): boolean` (checks `process.env` for presence and
  not `<placeholder>`).
- _Hides:_ nothing — these are small helpers, not public abstractions.
- _Trust contract:_ `hasLinkCredential` returns `true` if
  `linkSummary.credentials` has at least one entry for the provider.
  `hasResolvedEnvVar` returns `true` if the env var is present and not a
  placeholder. Both are accurate for their respective credential types.

**Conditional tool name prefixer**

- _Interface:_
  `conditionallyPrefixMCPTools(toolsByServer: Map<string, Record<string, Tool>>): Record<string, Tool>`.
- _Hides:_ the collision detection logic; the decision of whether to prefix; the
  prefixing transformation.
- _Trust contract:_ if only one server is present, output keys match the
  original tool names. If 2+ servers are present, all output keys start with
  `{serverId}_`. The tool descriptions are unmodified (the LLM can infer origin
  from the prefixed name when present). Original tool execute callbacks are
  preserved by reference.

**Workspace config description field**

- _Interface:_ `MCPServerConfig.description?: string` — optional string on
  workspace-configured server entries, provided by the updated
  `MCPServerConfigSchema` in `@atlas/agent-sdk`.
- _Hides:_ the fact that workspace-only servers can carry their own
  descriptions; the logic that propagates this field into
  `MCPServerMetadata.description` in `discoverMCPServers()`.
- _Trust contract:_ when `description` is present in a workspace config entry,
  `discoverMCPServers()` uses it for `metadata.description`. When absent,
  `metadata.description` is empty (as in v6).

### Data Isolation

Not applicable. The MCP registry is a single-tenant daemon resource. No
user-scoped database tables are touched.

## Testing Decisions

- **`discoverMCPServers` unit tests.** Verify that static + registry +
  workspace-configured servers are all returned. Verify workspace overrides are
  applied. Verify workspace-only servers appear with `source: "workspace"`.
  Verify `configured` is `false` when Link has no credential for the provider
  ID, and `true` when at least one credential exists. Verify `configured` is
  `false` for workspace-configured string env vars that are placeholders or
  missing from `process.env`, and `true` when resolved. Verify throws when
  workspace config fetch fails and no config is passed. Verify 50-server cap is
  enforced.

- **Link credential check tests.** Mock `linkSummary` with various credential
  states. Verify `configured: false` when no credential exists for the provider.
  Verify `configured: true` when one credential exists. Verify
  `configured: true` when multiple credentials exist. Verify `configured: true`
  when the single credential is expired (actual failure caught by graceful
  degradation at connection time).

- **Delegate input schema test.** Verify that `mcpServers` is an optional
  `z.array(z.string())` on the delegate input. Verify that `delegate` accepts
  `{ goal, handoff }` (no `mcpServers`) and runs with no MCP tools. Verify that
  `delegate` accepts `{ goal, handoff, mcpServers: ["strava-mcp"] }` and passes
  the ID through.

- **Delegate validation fail-fast test.** Mock `discoverMCPServers()` to return
  `[{ metadata: { id: "github" }, configured: true }]`. Call
  `delegate.execute({ goal, handoff, mcpServers: ["strava-mcp"] })`. Verify it
  returns `ok: false` with reason containing "Invalid MCP server ID:
  'strava-mcp' not found or not configured". Verify NO connection attempts are
  made.

- **Delegate validation unconfigured test.** Mock `discoverMCPServers()` to
  return `[{ metadata: { id: "strava-mcp" }, configured: false }]`. Call
  `delegate.execute({ goal, handoff, mcpServers: ["strava-mcp"] })`. Verify it
  returns `ok: false` with reason containing "not configured". Verify NO
  connection attempts are made.

- **Delegate with valid MCP servers test.** Mock `discoverMCPServers()` to
  return configured servers. Mock `createMCPTools` to return canned tools. Call
  `delegate.execute({ goal, handoff, mcpServers: ["strava-mcp"] })`. Verify the
  child `streamText` receives the (unprefixed) tools and the tool results flow
  back through the ledger.

- **Graceful degradation test.** Mock `createMCPTools` to throw for one server,
  succeed for another (using per-server invocations). Call
  `delegate.execute({ goal, handoff, mcpServers: ["failing", "working"] })`.
  Verify the child proceeds with the succeeding server's tools and the failure
  reason appears in `toolsUsed` and `serverFailures`.

- **All-selected-servers-fail test.** Mock `createMCPTools` to throw for all
  selected servers. Call
  `delegate.execute({ goal, handoff, mcpServers: ["a", "b"] })`. Verify it
  returns `ok: false` with `serverFailures` array containing both failures.
  Verify the child `streamText` is never started.

- **Slack-app injection test.** Verify that a selected server with a
  `provider: "slack-app"` Link ref gets its credential ID injected from the
  workspace mapping before `createMCPTools` is called. Verify failure when no
  wired bot exists.

- **Workspace chat turn test (non-delegate).** End-to-end: mocked user message
  "what time is it", verify `streamText` receives the normal tool set (with
  `delegate`), no MCP discovery overhead beyond the single turn-start
  `discoverMCPServers()` call.

- **Workspace chat turn test (delegate with MCP).** End-to-end: mocked user
  message "check my Strava rides", verify `streamText` receives the normal tool
  set (with `delegate`), and `delegate.execute()` validates the provided
  `mcpServers` IDs, connects, and wires MCP tools into the child.

- **Seamless auto-continue test.** End-to-end: mocked user message "what are my
  Stripe charges?", LLM calls `list_mcp_servers` → sees `configured: false`,
  calls `connect_service(provider="stripe-mcp")`, `connectServiceSucceeded()`
  fires, stream stops. Simulated `data-credential-linked` message arrives in
  next turn. Verify the LLM automatically calls `list_mcp_servers` again (to
  confirm `configured: true`), then calls `delegate` with
  `mcpServers=["stripe-mcp"]` and the original goal, without a user re-ask.

- **`list_mcp_servers` test.** Verify it returns all static +
  registry-imported + workspace-configured servers with `configured` status.
  Verify Link-backed servers with no credential show `configured: false` and
  include `provider`. Verify Link-backed servers with a credential show
  `configured: true` and omit `provider`. Verify workspace-configured servers
  with placeholder env vars show `configured: false` and include
  `requiredConfig`. Verify workspace-only servers appear with
  `source: "workspace"` and use the workspace config's `description` field when
  present. Verify tool execution fails with a clear error when workspace config
  is unavailable.

- **MCP disposal test.** Mock two per-server `createMCPTools` calls returning
  `{ tools, dispose: vi.fn() }`. Verify both dispose functions are called in
  `delegate.execute()`'s `finally` block even when one server fails connection.
  Verify disposal happens before `proxy.close()`.

- **Workspace config fetch failure test.** Verify `discoverMCPServers()` throws
  when the daemon config endpoint returns 500/404 and no `workspaceConfig` is
  passed. Verify `delegate.execute()` catches the throw and returns `ok: false`
  with the error reason. Verify `list_mcp_servers` surfaces the error to the LLM
  as a tool execution failure.

- **Delegate tool description mutation test.** Verify that `createDelegateTool`
  receives the discovery result and embeds the `list_mcp_servers` instruction in
  the tool description. Verify no server IDs are enumerated in the description.

- **Workspace config description propagation test.** Define a server only in
  workspace.yml with a `description` field. Verify that `discoverMCPServers()`
  returns it with `metadata.description` set correctly, and that
  `list_mcp_servers` returns it with the description.

- **Registry import Link provider creation test (prerequisite).** Mock the Link
  `POST /api/link/v1/providers` endpoint. Verify that
  `POST /api/mcp-registry/install` calls it with the correct
  `DynamicProviderInput` after storing the registry entry. Test the three
  translator cases: (a) npm+stdio with env vars → `DynamicApiKeyProviderInput`
  with `secretSchema` mapping env var names, (b) http remote without env vars →
  `DynamicOAuthProviderInput` with `mode: "discovery"`, (c) http remote with env
  vars → `DynamicApiKeyProviderInput`. Verify the provider ID matches the server
  ID.

- **Registry import Link provider failure test (prerequisite).** Mock Link
  provider creation to return 500. Verify that the registry entry is still
  stored (or rolled back, depending on chosen failure mode) and the install
  response indicates that credential setup is pending.

- **Translator Link provider input test (prerequisite).** Verify `translate()`
  returns `linkProvider` alongside `entry` for all supported upstream
  configurations. Verify `linkProvider.id` matches `entry.id`. Verify
  `linkProvider.type` is correct per transport. Verify env var names from
  upstream `environmentVariables` map correctly into `secretSchema` keys for
  apikey providers.

## Out of Scope

- **Multi-level delegation with MCP.** The child cannot re-delegate. Deeper
  trees are not supported.
- **Per-server tool allow/deny lists inside delegate.** The child gets all tools
  from each selected server. Fine-grained filtering (e.g., only
  `strava_getActivity` not `strava_deleteActivity`) is future work.
- **Auto-installation of missing MCP servers.** If the user mentions a service
  they haven't installed, the agent will say it's not available — not attempt to
  install from the registry.
- **Semantic / embedding-based server matching.** LLM-based routing is removed.
  The parent LLM uses its own reasoning and the `list_mcp_servers` metadata to
  select servers.
- **MCP server tool descriptions in system prompt.** Tool descriptions come from
  the MCP server at connection time (standard MCP behavior), not from our
  metadata.
- **Web-client support.** UI changes for `list_mcp_servers` results or delegate
  MCP visualization are playground-only in v1. The playground already has
  interactive credential card rendering for `connect_service`; extending this
  for MCP server connections (showing "Connected to Strava" after a delegate
  succeeds) is v2 work.
- **Auto-retry of expired credentials.** When a Link credential expires
  mid-delegate, the delegate fails with `serverFailures`. The LLM can surface
  the error and suggest `connect_service`, but there is no automatic retry or
  refresh flow. The user must manually reconnect.
- **MCP client pooling.** Each delegate call spins up fresh connections. Pooling
  is a future optimization.
- **Credential resolution cache with invalidation.** No session-scoped cache
  with credential mutation event listeners. The Link summary is fetched once per
  turn by the workspace-chat handler and passed to both `list_mcp_servers` and
  `delegate.execute()`. Connection-time Link failures (expired token, revoked
  credential) are handled by graceful degradation.
- **Dynamic truncation of routing prompt tokens.** Descriptions are short
  (~12-20 tokens per registry data), and the 50-server cap bounds total token
  count. No per-server truncation is implemented.
- **Auto-routing / `generateObject` / `labels` model.** All removed. The parent
  LLM is the router.
- **`assertStructuredOutputSupport` startup assertion.** Removed along with the
  auto-routing infrastructure.

## Further Notes

The shift from auto-routing to LLM-driven selection is a significant
simplification with better debuggability. In v5-v6, the routing call was an
opaque `generateObject` invocation that the LLM (and the user) had no visibility
into. Wrong server selections were impossible to diagnose without reading daemon
logs. With the v7 design, the LLM's reasoning is visible in the conversation: it
calls `list_mcp_servers`, sees the results, and makes an explicit choice. If it
chooses wrong, the user can see that in the chat transcript.

The removal of auto-routing also eliminates the `labels` model dependency and
the `assertStructuredOutputSupport` startup gate. The delegate path no longer
needs structured output at all. This reduces the surface area of the
implementation and removes a potential deployment blocker (the `labels` model
tier supporting `generateObject` was an unverified assumption).

The per-turn tool description mutation is lightweight: `createDelegateTool`
receives the discovery result (already computed for `list_mcp_servers`) and
embeds a static instruction string. No server IDs are enumerated, so the
description doesn't grow with server count and the LLM can't make assumptions
from stale name lists.

Fail-fast validation of `mcpServers` IDs prevents the "hallucinated server"
problem: the LLM might invent a server ID based on conversation context
("strava" instead of "strava-mcp"). The server-side validation catches this
immediately, returns a clear error, and the LLM can re-call `list_mcp_servers`
to get the correct IDs. This is more robust than silent filtering, which would
leave the LLM confused about why its selected servers didn't appear in the
child.

The unified `discoverMCPServers()` module remains the linchpin. Even though the
routing consumer is gone (replaced by the LLM), the module is still critical
for: (1) `list_mcp_servers` output, (2) delegate tool description generation,
(3) delegate ID validation, (4) `fetchAllTools` in the bundled-agent path. Its
single source of truth for server enumeration, workspace override merging, and
credential checking prevents the drift that would occur if each consumer
implemented its own logic.

The `serverFailures` field in the delegate result is now the primary error path
for MCP connection issues (alongside the fail-fast validation path for bad IDs).
When the LLM selects correctly but the connection fails (expired token, network
error), `serverFailures` gives it structured signal to surface to the user. This
replaces the v5-v6 "routing silently returned wrong servers" failure mode with
an explicit, debuggable error.

The system prompt clause about MCP servers is updated to mention the full
workflow: "Call `list_mcp_servers` to discover configured servers, then include
relevant IDs in the `mcpServers` field when delegating tasks that need them."
This cues the LLM to the two-step pattern without bloating the prompt with
server enumeration.

Removing the legacy `<mcp_servers>` tag from `formatWorkspaceSection` eliminates
redundant and inferior prompt injection. The tag only listed
workspace-configured server names (via unsafe casting), with no credential
status, no descriptions, and no registry awareness. `list_mcp_servers` provides
the same information with full metadata and credential status, and the LLM can
call it on demand.

The optional `description` field on `MCPServerConfig` (now added to
`@atlas/agent-sdk`'s `MCPServerConfigSchema`) ensures workspace-only servers
aren't listed with empty descriptions in `list_mcp_servers` output. Without it,
custom servers defined only in workspace.yml show up as `my-internal-api:`
(blank description) — useless for the LLM's selection reasoning.

Throwing on workspace config fetch failure (rather than silently omitting
workspace-configured servers) keeps the system honest. A silently partial list
would mean `list_mcp_servers` omits user-defined servers and the delegate can't
validate IDs against them — both confusing bugs that are hard to diagnose. Hard
failure surfaces the problem immediately.

The `workspaceConfig` threading through `DelegateDeps` eliminates a redundant
daemon fetch on every delegate call. The workspace chat handler already fetches
workspace config in parallel with other startup fetches — `delegate.execute()`
should not re-fetch the same data. This is a small interface change that reduces
delegate latency by one network roundtrip.

The 50-server cap on `discoverMCPServers()` bounds the `list_mcp_servers` output
size and prevents runaway token costs. Registry server descriptions are short
(~12-20 tokens), so 50 servers are manageable. The cap is a safety limit; in
practice, most workspaces have far fewer than 50 servers.

## Relationship to Pre-existing Link Infrastructure

### Single credential pathway via Link

All **blessed** MCP servers already use Link for credential storage (their
`configTemplate.env` contains Link refs). **Registry-imported** MCP servers
currently do NOT auto-create Link providers at install time — this is a
prerequisite that must be built before this plan is fully operational (see
"Prerequisites" below).

Once implemented, the registry import route (`POST /api/mcp-registry/install`)
will auto-create a Link provider at install time:

- **npm+stdio with env vars** → `type: "apikey"` provider, secret schema maps
  env var names to fields
- **http remote without env vars** (e.g., Notion) → `type: "oauth"` provider,
  OAuth discovery mode
- **http remote with env vars** → `type: "apikey"` provider

The `connect_service` tool (already in workspace chat's `primaryTools`) is the
**single entry point** for all MCP server credential setup — but only works for
servers that have a corresponding Link provider. When a user asks about an
unconfigured MCP server:

```
User: "what are my Stripe charges?"
LLM: calls list_mcp_servers → sees stripe-mcp: configured=false, provider="stripe-mcp"
LLM: "You need to connect Stripe first." calls connect_service(provider="stripe-mcp")
     → UI shows OAuth/API key card
     → User completes flow
     → Link stores credential
     → connectServiceSucceeded() fires → parent stream stops
     → UI sends data-credential-linked { provider: "stripe-mcp" }
LLM (new turn, auto-continuing): calls list_mcp_servers → sees stripe-mcp: configured=true
LLM: calls delegate(goal="fetch Stripe charges", mcpServers=["stripe-mcp"])
     → validation passes
     → createMCPTools → resolveEnvValues → fetches Link credential → works
```

For non-MCP Link providers (Notion, Linear, etc.), the same
`connectServiceSucceeded()` stop and `data-credential-linked` resume applies,
but the LLM has no automatic `delegate` path — it simply confirms the connection
and waits for the user's next instruction. MCP providers are the only case where
the LLM auto-continues because the original user request was functional ("fetch
my charges") rather than a connection request ("connect Stripe").

### Credential states and transitions

| State                | How detected                                                    | User action                                                                                               | Next state                                           |
| -------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Provider not created | Server not in registry                                          | `connect_mcp_server` (or registry install)                                                                | Provider created, no credential                      |
| No credential        | `list_mcp_servers` → `configured: false`, `provider` set        | `connect_service(provider)` → OAuth/API key → `connectServiceSucceeded()` fires → new turn auto-continues | Credential stored in Link; LLM auto-calls `delegate` |
| Credential exists    | `list_mcp_servers` → `configured: true`                         | Delegate with `mcpServers=[id]`, validation passes, `createMCPTools` resolves                             | Works                                                |
| Credential expired   | `createMCPTools` → `resolveEnvValues` throws at connection time | `connect_service(provider)` to refresh                                                                    | Credential refreshed                                 |

### Async credential check eliminates the false-positive

The previous sync-only approach (`areCredentialsResolvedSync`) returned
`configured: true` for all Link-backed servers because it couldn't check Link
without an HTTP call. This meant the routing prompt included servers with
expired/missing credentials, the delegate attempted connection, failed, and
surfaced a generic error. The user had no signal that the credential needed
reconnection until the delegate failed.

With the async Link summary check, `configured: false` is accurate. The LLM sees
the server is unconfigured **before** delegating and can proactively guide the
user to `connect_service`. After the user connects, the LLM auto-continues in
the next turn (triggered by `data-credential-linked`) and calls `delegate`
without requiring the user to re-ask. This eliminates both the "delegate → fail
→ explain → reconnect → re-delegate" loop and the "connect → re-ask → delegate"
friction.

### `connectServiceSucceeded()` stop condition

`connectServiceSucceeded()` remains a stop condition on the **parent's**
`streamText`. It fires when `connect_service` returns `{ provider, progress }`
in the parent tool result — the same as any other Link-connected service. The
stream must stop so the UI can render the OAuth/API key card and the user can
complete the flow.

When the user finishes connecting, the UI sends a `data-credential-linked`
message, which starts a new turn. The system prompt includes a clause that
instructs the LLM: **when you receive a `data-credential-linked` event for a
provider you previously asked the user to connect in order to complete a task,
automatically proceed with that task.** For MCP providers, this means calling
`list_mcp_servers` to confirm `configured: true`, then calling `delegate` with
the relevant `mcpServers` and the original goal — the user does not need to
re-ask their question.

Example seamless flow:

```
User: "what are my Stripe charges?"
LLM: calls list_mcp_servers → sees stripe-mcp: configured=false, provider="stripe-mcp"
LLM: "You need to connect Stripe first." calls connect_service(provider="stripe-mcp")
     → UI shows OAuth/API key card
     → connectServiceSucceeded() fires → parent stream stops
     → User completes flow
     → Link stores credential
     → UI sends data-credential-linked { provider: "stripe-mcp" }
LLM (new turn, auto-continuing): calls list_mcp_servers → sees stripe-mcp: configured=true
LLM: calls delegate(goal="fetch Stripe charges", mcpServers=["stripe-mcp"])
     → validation passes
     → createMCPTools → resolveEnvValues → fetches Link credential → works
```

The system prompt clause is updated to cover this pattern. The LLM's
conversation history contains the original user question, its own
`connect_service` call, and the `data-credential-linked` event — enough context
to infer the pending goal and `mcpServers` selection without user re-entry.

MCP servers run in the **child's** `streamText` via `delegate.execute()`. The
child is autonomous — its completion (via `finish` tool) resumes the parent.
There is no stop condition tied to MCP tool calls inside the child. This is
correct and consistent with all other delegate use cases.

### Workspace-configured servers (hybrid)

Servers defined manually in `workspace.yml` (`tools.mcp.servers.*`) can use
either:

- **Link refs**: `{ from: "link", provider: "...", key: "..." }` — checked via
  Link summary, same flow as registry-imported servers
- **String env vars**: `ENV_VAR: "value"` or `ENV_VAR: "<placeholder>"` —
  checked via `process.env`, user sets env var manually

This hybrid is intentional. Registry-imported and blessed servers (the common
case) use Link. Power users with custom servers can still use raw env vars
without creating a Link provider.
