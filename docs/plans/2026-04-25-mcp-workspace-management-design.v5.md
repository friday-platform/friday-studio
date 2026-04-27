<!-- v5 - 2026-04-26 - Generated via /improving-plans from docs/plans/2026-04-25-mcp-workspace-management-design.v4.md -->

# MCP Workspace Management & Interactive Test Chat

## Problem Statement

Friday users install MCP servers from the registry into a platform-wide catalog, but those servers remain invisible to workspaces until someone hand-edits `workspace.yml` to add them under `tools.mcp.servers`. There is no UI for:

- Seeing which MCP servers are enabled in a given workspace
- Browsing the catalog and enabling a server in a workspace with one click
- Removing a server from a workspace without deleting it from the catalog
- Testing whether a server actually works before relying on it in agent workflows
- Seeing which workspaces reference a given server from the server's detail page

The gap between "installed in catalog" and "available to agents" is a YAML-only chasm. Users must know the server ID, copy its `configTemplate` into the correct YAML path, and hope credentials resolve. When it doesn't work, there is no lightweight way to probe the connection.

## Solution

Build a bidirectional bridge between the MCP catalog and workspace configuration, surfaced in both the web UI and workspace chat:

1. **Workspace MCP Manager** — a new page under each workspace (`/platform/:workspaceId/mcp`) that shows enabled servers and available catalog servers in a skills-page-style layout. Users can enable or disable catalog servers with one click, which mutates the workspace configuration atomically. Custom (workspace-only) servers also appear in the enabled list.

2. **MCP Detail Page Enhancements** — add a live tool listing (via connection probe), workspace usage reverse index, and a **Test Chat** panel that spins up a minimal LLM session with just that server's tools so users can interactively verify functionality (e.g., "what am I listening to" for Spotify).

3. **Backend Mutations & Endpoints** — pure config mutation functions for enable/disable with reference-safety guards, dedicated daemon routes for workspace-scoped MCP operations, and a streaming test-chat endpoint that reuses production credential resolution and MCP tool creation.

4. **Workspace Chat Tools & Skill** — three new tools (`get_workspace_mcp_status`, `enable_mcp_server`, `disable_mcp_server`) plus a system skill that teaches the workspace-chat agent the catalog-vs-workscope mental model, so users can manage MCP servers conversationally without touching the UI.

## User Stories

1. As a workspace owner, I want to see which MCP servers are currently enabled in my workspace, so that I know what external capabilities my agents have access to.

2. As a workspace owner, I want to browse the platform catalog of installed/registry MCP servers and enable one in my workspace with a single click, so that I never hand-edit YAML.

3. As a workspace owner, I want to disable an MCP server from my workspace without deleting it from the catalog, so that I can temporarily remove it from agent tool sets.

4. As a workspace owner, I want to see whether each enabled MCP server has its credentials configured, so that I know which ones are ready to use.

5. As a platform admin, I want to see which workspaces have a given MCP server enabled, so that I understand the blast radius before updating or removing it.

6. As a platform admin, I want to see what tools a catalog server exposes and whether its connection is healthy, so that I can diagnose why agents can't use it.

7. As a platform admin, I want to add a catalog server to a workspace directly from the server's detail page, so that I don't context-switch between pages.

8. As a user, I want to test an MCP server interactively with a minimal LLM chat before adding it to a workspace, so that I can verify it actually works with my credentials.

9. As a user, I want the test chat to show me exactly which tools the server exposes and which ones the LLM calls, so that I understand the server's capability surface.

10. As a user, I want the test chat to use the same credential resolution path as production agents, so that if it works in the test, it will work in the workspace.

11. As a user, I want custom MCP servers defined manually in workspace YAML to appear in the workspace MCP manager and be disable-able like any other server, so that I don't lose visibility into hand-configured integrations.

12. As a developer, I want the enable/disable mutations to validate through `WorkspaceConfigSchema` before persisting, so that corrupt configs can't be introduced through the UI.

13. As a developer, I want the workspace MCP manager to derive its data from `discoverMCPServers`, the same canonical discovery function used by the workspace chat agent, so that the UI and backend agree on what constitutes an "enabled" server.

14. As a user, I want to see transport type badges (stdio/http) and security ratings for each server, so that I can make informed decisions about what I enable.

15. As a workspace owner, I want the enable action to copy the server's `configTemplate` from the catalog into my workspace config, so that the server is configured identically to how the platform intended.

16. As a user, I want to test an enabled MCP server directly from the workspace MCP manager page, so that I can diagnose issues without leaving the workspace context.

17. As a user chatting with my workspace, I want to say "enable the GitHub server here" and have the LLM do it in one turn, so that I never touch YAML or the UI.

18. As a user, I want to say "which MCP servers are active in this workspace?" in chat and get an answer that only lists enabled servers, so that I know what's actually wired into my agents.

19. As a user, I want to say "disable Spotify from this workspace" in chat and have the LLM warn me if an agent still references it, so that I don't accidentally break a running job.

## Implementation Decisions

### Module Boundaries

**`packages/config/src/mutations/mcp-servers.ts`**

- **Interface:** `enableMCPServer(config: WorkspaceConfig, serverId: string, configTemplate: MCPServerConfig): MutationResult<WorkspaceConfig>` and `disableMCPServer(config: WorkspaceConfig, serverId: string, options?: { force?: boolean }): MutationResult<WorkspaceConfig>`
- **Hides:** The exact YAML path (`tools.mcp.servers.{id}`), the deep merge of `configTemplate` into workspace config, Zod validation of the resulting config, and reference-safety checking for LLM agent tool arrays.
- **Trust contract:** If `enableMCPServer` returns `ok: true`, the resulting config is valid per `WorkspaceConfigSchema` and the server is present under `tools.mcp.servers.{serverId}` with the provided `configTemplate`. If the server was already present, the mutation succeeds idempotently (returns `ok: true` with the unchanged config) — no conflict error on duplicate enable. If `disableMCPServer` returns `ok: true`, the server key is absent from `tools.mcp.servers` and, if `force` was used, all LLM agent `tools` arrays (top-level agents **and** FSM job actions) no longer reference it. If agents or job steps reference the server and `force` is not set, it returns a `conflict` error with `willUnlinkFrom` listing affected agents and jobs.

**`packages/core/src/mcp-registry/workspace-mcp.ts` (thin wrapper)**

- **Interface:** `getWorkspaceMCPStatus(workspaceId: string, workspaceConfig: WorkspaceConfig, linkSummary?: LinkSummary): Promise<{ enabled: EnrichedMCPServer[], available: EnrichedMCPServer[] }>`
- **Hides:** The call to `discoverMCPServers()`, the merge with `deriveIntegrations()` and `extractJobIntegrations` for agent/job assignments, and the partition logic.
- **Trust contract:** Callers MUST pass `workspaceConfig` explicitly to avoid an internal HTTP round-trip (the daemon route handler already has this data from `manager.getWorkspaceConfig()`). `enabled` contains every server whose ID appears in `workspaceConfig.tools.mcp.servers` (both catalog-backed and custom), decorated with metadata from `discoverMCPServers` plus `agentIds` from `deriveIntegrations` and `jobIds` from `extractJobIntegrations`. `available` contains all catalog servers (static + registry) not present in the workspace config. `configured` is taken directly from `discoverMCPServers` credential checks.

**`apps/atlasd/routes/workspaces/mcp.ts`**

- **Interface:** `GET /api/workspaces/:workspaceId/mcp` returns `{ enabled: EnrichedMCPServer[], available: EnrichedMCPServer[] }`. `PUT /api/workspaces/:workspaceId/mcp/:serverId` atomically enables a server. `DELETE /api/workspaces/:workspaceId/mcp/:serverId` removes a server, with optional `?force=true` for cascade.
- **Hides:** The `discoverMCPServers()` call (with workspaceConfig explicitly passed), `applyMutation()` cycle, catalog lookup, workspace existence checks, blueprint-workspace guards (returns 422), and agent-reference conflict detection.
- **Trust contract:** `GET` returns exactly the servers in the workspace config plus the catalog delta, with `configured` accurate as of the request. The route handler MUST pass `workspaceConfig` (and `linkSummary` if available) to `discoverMCPServers` / `getWorkspaceMCPStatus` to avoid an internal HTTP round-trip — the handler already has this data from `manager.getWorkspaceConfig()`. `PUT` with a valid `serverId` atomically adds the server's `configTemplate` to the workspace config. If the server is already enabled, `PUT` succeeds idempotently (200 with server info, no side effect). `DELETE` removes the server, returning 409 if agents or job steps reference it and `force` is absent. Both validate before write and return 409/422/404 on conflict, validation failure, or missing workspace/server.
- **Blueprint workspaces:** For blueprint-linked workspaces, `GET` works normally (read-only view). `PUT` and `DELETE` return 422 with message "This workspace uses a blueprint — direct config mutations are not supported." The UI disables enable/disable actions and shows a "Managed via blueprint" badge.

**`apps/atlasd/routes/mcp-registry/tools.ts`**

- **Interface:** `GET /api/mcp/:id/tools` returns `{ ok: true, tools: Array<{name: string, description?: string}> }` or `{ ok: false, error: string, phase: "dns" | "connect" | "auth" | "tools" }`.
- **Hides:** The full `createMCPTools` call chain (including credential resolution, transport setup, retries, and `client.tools()`), plus error classification into phases.
- **Trust contract:** A successful response means the server is reachable and its tool list is accurate as of the request. A failed response includes enough phase information for the UI to show a meaningful error (e.g., "DNS failed — check the URL" vs "Authentication failed — check credentials").

**`apps/atlasd/routes/mcp-registry/test-chat.ts`**

- **Interface:** `POST /api/mcp/:id/test-chat` accepts `{ message: string }` and optional query `?workspaceId=<id>`, returns SSE stream with events: `chunk`, `tool_call`, `tool_result`, `done`, `error`.
- **Hides:** The full agent context construction (credential resolution via `resolveEnvValues` or workspace-scoped `linkSummary`, `createMCPTools`, platform model resolution from `friday.yml`, `streamText` invocation), and the fact that this is a throwaway session with no persistence.
- **Trust contract:** The stream uses the exact same credential resolution and MCP connection path as production workspace agents. If `workspaceId` is provided, the endpoint fetches that workspace's config and resolves credentials through its `linkSummary`, matching the workspace chat agent's resolution path exactly. If the test chat succeeds, the server is production-ready for that workspace. Tool calls are emitted as discrete events so the UI can render them. The session has no memory, no workspace context, and no access to any other tools.

**`tools/agent-playground/src/routes/platform/[workspaceId]/mcp/+page.svelte`**

- **Interface:** Renders two primary sections (Enabled in this workspace, Available from catalog) with enable/disable actions. Inline catalog search + install pattern copied from the skills page. Each enabled server card includes a **Test** button that opens an inline test-chat panel for that server (using the current workspace ID for credential resolution).
- **Hides:** Query keys, mutation invalidation, optimistic updates, and the fact that "enable" is a config mutation under the hood.
- **Trust contract:** Clicking Enable on an available server makes it appear in Enabled within one round-trip. Clicking Disable removes it. Clicking Test on an enabled server opens a minimal streaming chat panel with workspace-scoped credential resolution. Custom servers are rendered in the Enabled list with a "Custom" badge and the same Disable button. The inline search filters the catalog in real-time.
- **Blueprint workspaces:** If the workspace is blueprint-linked, enable/disable buttons are disabled with a "Managed via blueprint" tooltip. The page remains otherwise functional.

**`tools/agent-playground/src/lib/queries/workspace-mcp.ts`**

- **Interface:** `workspaceMcpQueries.status(workspaceId)`, `workspaceMcpQueries.enable(workspaceId, serverId)`, `workspaceMcpQueries.disable(workspaceId, serverId, force?)`, `workspaceMcpQueries.testChat(serverId, message, workspaceId?)`.
- **Hides:** Query key hierarchy, `queryClient.invalidateQueries` on mutation success, SSE subscription handling, and error parsing.
- **Trust contract:** Query key hierarchy follows the workspace-queries pattern: `["daemon", "workspace", workspaceId, "mcp"]` for the status query, enabling hierarchical invalidation on mutation success. After a successful enable mutation, `workspaceMcpQueries.status` refetches automatically. The test-chat query initiates an SSE connection and yields parsed events. Errors are surfaced as thrown errors with `.message` suitable for toast display.

**`mcp-server-detail.svelte` (enhanced)**

- **Interface:** Additional sections: Connection Test, Workspace Usage, Test Chat. Receives `server`, `tools`, `workspaces`, and `testChatStream` as props or derived queries.
- **Hides:** Whether the tool list came from the registry or a live probe. Whether workspace usage is computed client-side or server-side.
- **Trust contract:** The Connection Test button attempts a live probe and shows tool count + latency on success. Workspace Usage shows all workspaces with enable/disable links. Test Chat is a self-contained streaming panel that works without page reload.

### Workspace Chat Tools

**`packages/system/agents/workspace-chat/tools/workspace-mcp-status.ts`**

- **Interface:** `tool({})` — no input params. Returns `{ enabled: ServerSummary[], available: ServerSummary[] }`.
- **Implementation:** Calls `GET /api/workspaces/:workspaceId/mcp` via `@atlas/client/v2`.
- **Trust contract:** Returns the exact partition the UI sees. `enabled` contains every server in `workspaceConfig.tools.mcp.servers`; `available` contains catalog servers not yet enabled. `configured` is accurate as of the call. Never falls back to a flat list.

**ServerSummary shape:**
```typescript
{
  id: string;
  name: string;
  source: "static" | "registry" | "workspace";
  configured: boolean;
  agentIds?: string[];
  jobIds?: string[];
}
```

**`packages/system/agents/workspace-chat/tools/enable-mcp-server.ts`**

- **Interface:** `tool({ serverId: string })` — just the server ID.
- **Implementation:** Calls `PUT /api/workspaces/:workspaceId/mcp/:serverId` via `@atlas/client/v2`. Handles 200 (idempotent success), 404 (unknown server), 409 (validation conflict), 422 (blueprint compilation failure).
- **Trust contract:** If the server exists in the catalog, it is added to the workspace config with its `configTemplate` verbatim. If already enabled, returns success with no mutation. On failure, returns a structured error the LLM can explain.

**`packages/system/agents/workspace-chat/tools/disable-mcp-server.ts`**

- **Interface:** `tool({ serverId: string, force?: boolean })`.
- **Implementation:** Calls `DELETE /api/workspaces/:workspaceId/mcp/:serverId?force={force}` via `@atlas/client/v2`. Handles 200 (removed), 404 (not enabled), 409 (agents/jobs reference it — returns `willUnlinkFrom` listing affected agents and jobs).
- **Trust contract:** Without `force`, the call is safe — it refuses if any agent or job step still references the server. The LLM can surface the list and ask the user to confirm. With `force`, it cascades: removes the server from workspace config and strips all references from agent `tools` arrays and job step `tools` arrays.

### Workspace Chat System Skill

**Path:** `packages/system/skills/mcp-workspace-management/SKILL.md`

**Frontmatter:**
```yaml
---
name: mcp-workspace-management
description: "Teach workspace-chat the mental model of MCP server catalog vs workspace-scoped enablement. Use when the user asks to add, remove, enable, disable, or configure MCP servers in a workspace."
user-invocable: false
---
```

**Contents:**

- **Four actions, four scopes:**
  1. `search_mcp_servers` + `install_mcp_server` → **global catalog**. The server becomes available platform-wide. Does NOT make it available to agents in any workspace.
  2. `enable_mcp_server` → **workspace scope**. Copies the server's `configTemplate` into `workspace.yml`'s `tools.mcp.servers`. The server is now available to agents in this workspace. Idempotent.
  3. `disable_mcp_server` → **workspace scope**. Removes the server from `tools.mcp.servers` in this workspace. The server remains in the catalog. Safe by default (refuses if referenced by agents/jobs); use `force` to override.
  4. `delete_mcp_server` (not yet implemented in chat tools) → **global catalog**. Destructive; removes the server from the catalog entirely. Only appropriate for custom servers the user created.

- **When to use which:**
  - User says "add X to this workspace" → `enable_mcp_server(X)` if X is already in the catalog. If not in the catalog, `install_mcp_server` (registry) or `create_mcp_server` (custom) first, then `enable_mcp_server`.
  - User says "remove X from this workspace" → `disable_mcp_server(X)`. Do NOT use `delete` — that destroys the catalog entry.
  - User says "I don't see X in my workspace" → `get_workspace_mcp_status` to check if it's in `enabled` or `available`.
  - User says "uninstall X" or "delete X" → clarify: from the workspace (`disable`) or from the catalog (`delete`)?

- **Reference safety:**
  - `disable_mcp_server` without `force` returns 409 + `willUnlinkFrom` listing agents and jobs. The LLM should surface this and ask the user to confirm.
  - If the user confirms, retry with `force: true`. This removes the server and strips all references.
  - Blueprint workspaces route through the blueprint recompile path — the tool handles this transparently.

- **Custom servers:**
  - Servers with `source: "workspace"` appear in `enabled` but have no catalog backing. They can be disabled like any other, but re-enabling requires manual YAML editing (the LLM should say this).

### Integration into workspace-chat.agent.ts

Add the three tool imports and spread them into `primaryTools` alongside the existing MCP tools (`list_mcp_servers`, `search_mcp_servers`, `install_mcp_server`, `create_mcp_server`):

```typescript
import { createGetWorkspaceMcpStatusTool } from "./tools/workspace-mcp-status.ts";
import { createEnableMcpServerTool } from "./tools/enable-mcp-server.ts";
import { createDisableMcpServerTool } from "./tools/disable-mcp-server.ts";

// ... in primaryTools:
...createGetWorkspaceMcpStatusTool(workspaceId, logger),
...createEnableMcpServerTool(workspaceId, logger),
...createDisableMcpServerTool(workspaceId, logger),
```

The `list_mcp_servers` tool remains for global catalog discovery (e.g., "what MCP servers do I have installed?"). The new tools handle workspace-scoped actions.

### System skill registration

The skill is auto-loaded by the workspace-chat agent's `useWorkspaceSkills: true` flag (same mechanism as `workspace-api`, `friday-cli`, etc.). No explicit registration needed — it lives in the `packages/system/skills/` directory and is discovered at daemon startup.

### Data Isolation

Not applicable. The MCP registry and workspace configs are single-tenant daemon resources. No user-scoped database tables are touched.

## Reference-Safety: Unified `findServerReferences`

Both `disableMCPServer` and the GET endpoint's `agentIds`/`jobIds` population use a single shared helper:

```typescript
interface ServerReference {
  agentIds: string[];
  jobIds: string[];
}

function findServerReferences(config: WorkspaceConfig, serverId: string): ServerReference;
```

This helper is **new code** — it does not exist in the current codebase. It walks:
1. **Top-level LLM agents:** `config.agents` entries with `type === "llm"`, checking `config.tools` arrays.
2. **FSM job actions:** `config.jobs[].fsm.states[].entry[]` entries with `type === "llm"`, checking `tools` arrays.

The helper returns `{ agentIds: string[], jobIds: string[] }` so callers can construct appropriate conflict messages and cascade cleanup. It is implemented in `packages/config/src/mutations/mcp-servers.ts` alongside the mutation functions. Note that `deriveIntegrations` (agents only) and `extractJobIntegrations` (provider names, not server IDs) do not provide this mapping — the helper is written from scratch.

## API Contracts

**`GET /api/workspaces/:workspaceId/mcp`**

Response schema (Zod):
```typescript
z.object({
  enabled: z.array(z.object({
    id: z.string(),
    name: z.string(),
    source: z.enum(["static", "registry", "workspace"]),
    configured: z.boolean(),
    agentIds: z.array(z.string()).optional(),
    jobIds: z.array(z.string()).optional(),
  })),
  available: z.array(z.object({
    id: z.string(),
    name: z.string(),
    description: z.string().optional(),
    source: z.enum(["static", "registry"]),
    configured: z.boolean(),
  })),
})
```

`enabled` is all servers whose IDs exist in `workspaceConfig.tools.mcp.servers`, decorated by `discoverMCPServers()` metadata and merged with `deriveIntegrations()` agent assignments and `extractJobIntegrations()` job step assignments. `available` is the catalog (static + registry from `discoverMCPServers`) minus enabled IDs **and** minus any candidate with `metadata.source === "workspace"` (workspace-only custom servers must not leak into the available list). `configured` is taken directly from `discoverMCPServers` credential checks.

Custom (workspace-only) servers appear in `enabled` with `source: "workspace"` and a `name` derived from the config key (falling back to `MCPServerConfig.description` if present). They are disable-able like any other enabled server.

`toolCount` is intentionally **omitted** from this endpoint. The Connection Test (`GET /api/mcp/:id/tools`) is the authoritative source for live tool counts.

**`PUT /api/workspaces/:workspaceId/mcp/:serverId`**

No request body required. The serverId is in the URL path.

Enable flow:
1. Fetch workspace config.
2. Look up `serverId` in the consolidated catalog via `discoverMCPServers()` (passing workspaceConfig explicitly).
3. If not found, return 404.
4. If the workspace has a linked blueprint, return 422.
5. Call `enableMCPServer(config, serverId, catalogEntry.configTemplate)`.
6. On success (including idempotent success — server already enabled), write config via `applyMutation` using `FilesystemConfigWriter`.
7. Return `{ server: { id, name } }`.

Both flows validate before write and return 409/422/404 on conflict, validation failure, or missing workspace/server.

**`DELETE /api/workspaces/:workspaceId/mcp/:serverId`**

Query param: `force?: boolean`.

Disable flow:
1. Fetch workspace config.
2. If the workspace has a linked blueprint, return 422.
3. Call `disableMCPServer(config, serverId, { force: c.req.query("force") === "true" })`.
4. On `not_found`, return 404.
5. On `conflict` (agents or job steps reference the server), return 409 with message listing affected agents and jobs.
6. On success, write config.
7. Return `{ removed: serverId }`.

Both flows validate before write and return 409/422/404 on conflict, validation failure, or missing workspace/server.

**`GET /api/mcp/:id/tools`**

1. Look up server in consolidated registry via `discoverMCPServers` (or static + adapter direct lookup if workspace context is irrelevant).
2. If not found, 404.
3. Resolve env values (same path as `createMCPTools`).
4. Attempt connection with short timeout (~5s).
5. Call `client.tools()`.
6. Return tool list or classified error.

**`POST /api/mcp/:id/test-chat`**

Query param: `workspaceId?: string` (optional).

1. Look up server in consolidated registry.
2. If `workspaceId` is provided:
   - Fetch workspace config for that workspace.
   - Build a `linkSummary` from the workspace config (same path as `discoverMCPServers`).
   - Resolve env values using the workspace-scoped `linkSummary`.
3. If `workspaceId` is absent, resolve env values globally (same path as `createMCPTools`).
4. `createMCPTools({ [id]: resolvedConfig })`.
5. Resolve conversational model: read `atlas.models.conversational` from Atlas config (`friday.yml`), fallback to platform default.
6. `streamText({ model, messages: [{role: "user", content: message}], tools })`.
7. Stream SSE events:
   - `chunk` for each text delta
   - `tool_call` when a tool is invoked (name + args)
   - `tool_result` when tool returns
   - `done` on completion
   - `error` on failure (with same phase classification as `/tools`)

## Frontend Components

**Workspace MCP Manager Page**

Two primary sections, styled identically to the skills page:

- **Enabled in this workspace**: Cards from `enabled` array. Shows name, `configured` status dot (green = credentials ready, amber = missing credentials), agent references, job references, "Disable" button, and **"Test"** button. Custom servers tagged "Custom" with a note that re-adding requires YAML editing. Clicking **Test** opens an inline collapsible test-chat panel for that specific server, scoped to the current workspace (credentials resolve through the workspace's Link context).
- **Available from catalog**: Cards from `available` array. Shows name, description snippet, `configured` status, and "Enable" button. Clicking navigates to `/mcp/:id` via stretched link. Servers with `configured: false` show an amber dot and a "Connect credentials" link to the MCP detail page.

Inline install row at top (copied from skills page): search input + Install button that searches the catalog and enables the selected server.

**Blueprint workspace treatment:** If the workspace is blueprint-linked, enable/disable buttons are disabled with a "Managed via blueprint" tooltip. The page otherwise functions identically.

**MCP Detail Page Additions**

Insertions into existing detail pane, below Credentials:

- **Connection Test**: Collapsible section. Button triggers `GET /api/mcp/:id/tools`. On success: green pill "Connected · 14 tools · 230ms" + collapsible tool list. On failure: red pill with phase-specific message + "Retry" button.
- **Workspace Usage**: Sub-section "Used in N workspaces". Per-workspace mini-card with name, configured dot, link to `/platform/:id/mcp`. Dropdown + "Add to workspace" for workspaces without it.
- **Test Chat**: Collapsible section. Minimal chat UI: input box + streaming output area. No history, no persistence. Shows tool calls inline as small cards. System prompt is hardcoded: "You have access to {serverName} via MCP tools. Answer the user's question using the available tools."

### Navigation

Add "MCP" to workspace sub-nav in `sidebar.svelte`, between "Skills" and "Jobs", using `IconLarge.Wrench`. Top-level "MCP Servers" link (`/mcp`) remains unchanged.

## Testing Decisions

- **Config mutation unit tests**: Test `enableMCPServer` with valid catalog entry (asserts `tools.mcp.servers.{id}` populated). Test `enableMCPServer` when server is already enabled (asserts `ok: true`, config unchanged — idempotent). Test `disableMCPServer` when present (asserts key removed) and when absent (asserts `not_found`). Test `disableMCPServer` when referenced by a top-level LLM agent — without `force` (asserts `conflict` with agent ID in `willUnlinkFrom`) and with `force` (asserts key removed and agent `tools` array cleaned). Test `disableMCPServer` when referenced by an FSM job step — without `force` (asserts `conflict` with job ID in `willUnlinkFrom`) and with `force` (asserts key removed and step `tools` array cleaned). Test both with corrupted base config to verify validation still catches errors.

- **Daemon route tests**: Test `GET /api/workspaces/:id/mcp` returns correct enabled/available split, including custom servers in `enabled`. Test `GET` does not include workspace-only servers in `available`. Test `PUT /api/workspaces/:id/mcp/:serverId` with valid serverId (asserts config written). Test `PUT` with unknown serverId (404). Test `PUT` with already-enabled serverId (200, idempotent success). Test `DELETE /api/workspaces/:id/mcp/:serverId` with enabled server (asserts removed). Test `DELETE` with non-enabled server (404). Test `DELETE` with agent references and no `force` (409). Test `DELETE` with agent references and `?force=true` (asserts removed + agent tools cleaned). Test `DELETE` with job step references and no `force` (409 with job ID). Test `DELETE` with job step references and `?force=true` (asserts removed + FSM step tools cleaned). Test blueprint workspace returns 422 on PUT and DELETE. Test that `GET` passes workspaceConfig to `discoverMCPServers` (verify via spy/mock — no internal HTTP call to self).

- **Tool probe tests**: Mock `createMCPTools` to return tools / throw. Test `GET /api/mcp/:id/tools` returns correct tool list on success. Test error classification: DNS failure → `phase: "dns"`, auth failure → `phase: "auth"`, tools() timeout → `phase: "tools"`.

- **Test chat tests**: Mock `streamText` to yield chunks and tool calls. Test SSE event sequence: `chunk` → `tool_call` → `tool_result` → `done`. Test error path returns `error` event with classified phase. Test that the endpoint resolves model from Atlas config, falls back to default, and uses the same `resolveEnvValues` path as production. Test workspace-scoped resolution: mock `workspaceId` query param, verify credential resolution uses that workspace's `linkSummary`.

- **Frontend architecture test**: Assert that the workspace MCP page uses the same row/card pattern as the skills page (stretched link + action button) to maintain UI consistency.

- **Chat tool unit tests**: Test each tool's client call via mocked `@atlas/client/v2`. Test 200/404/409/422 response handling. Test `disable` with `force` true vs false. Test that `get_workspace_mcp_status` returns the enabled/available partition, not a flat list.
- **Chat integration tests**: Test that a chat turn with "enable github" reaches `enable_mcp_server`. Test that "what MCP servers are active here?" reaches `get_workspace_mcp_status`. Test that a disable with active references surfaces the 409 conflict and prompts for confirmation.
- **Skill content test**: Verify the SKILL.md teaches the four-action model and mentions the `force` confirmation pattern.

## Out of Scope

- **Credential picker per workspace** (Level B): When multiple Link credentials exist for a provider, selecting which one a workspace uses. Currently the workspace inherits the provider ref and Link resolves the first/default credential at runtime.
- **Inline OAuth/API key setup from workspace page** (Level B/C): The workspace MCP manager shows "missing credential" status but the fix flow is "go to MCP detail page → connect credentials → return".
- **Tool allow/deny editing per workspace**: The `configTemplate` is copied as-is; users who need tool filtering still edit YAML.
- **Multi-server test chat**: The test chat uses exactly one server. Testing combinations of servers is a workspace concern, handled by the actual workspace chat.
- **Persistent test chat history**: The test chat is ephemeral by design. No messages are stored. Each request is a single-shot exchange with no conversational memory — users cannot ask follow-up questions that build on prior tool results. This is a deliberate simplicity tradeoff: multi-turn testing can be done in the actual workspace chat.
- **Auto-refresh of tool list**: The Connection Test section does not poll. User clicks "Test" to get current state.
- **Workspace-level MCP server overrides**: If a user wants to customize transport or env for a catalog server in a specific workspace, they still edit YAML. The enable mutation copies the template verbatim.
- **Blueprint workspace MCP management** (Level B): Blueprint-linked workspaces show the MCP manager page but enable/disable actions are disabled with a "Managed via blueprint" tooltip. Direct config mutations return 422. A future version may add blueprint-aware MCP management via a top-level `mcpServers` array in the blueprint schema and routing mutations through the blueprint recompile path.
- **Rate limiting**: v1 does not implement rate limiting for the test chat endpoint. A future version may add per-user throttling via Deno KV.

## Further Notes

### Relationship to Existing Infrastructure

The `discoverMCPServers` function in `packages/core/src/mcp-registry/discovery.ts` is the canonical source of truth for server enumeration. The workspace MCP manager route consumes it directly — no manual static+adapter lookup, no drift risk. `discoverMCPServers` returns:
- `metadata`: full `MCPServerMetadata` (name, description, securityRating, source, configTemplate)
- `mergedConfig`: workspace overrides applied
- `configured`: credential resolution status

The workspace MCP GET endpoint also calls `deriveIntegrations(config)` and `extractJobIntegrations(config)` (or the unified `findServerReferences` helper) to extract `agentIds` and `jobIds` per server, then merges those assignments into the `discoverMCPServers` results. This produces the `enabled` array with both metadata and agent/job references.

The preflight endpoint (`/api/workspaces/:id/integrations/preflight`) is **not** used by the workspace MCP manager. `configured` status comes from `discoverMCPServers` credential checks, which are identical to what the workspace chat agent uses. Preflight remains useful for agent-specific credential diagnostics but is not repurposed for server-level status display.

### Performance: Pass workspaceConfig Explicitly

The route handler for `GET /api/workspaces/:workspaceId/mcp` already loads workspace config via `manager.getWorkspaceConfig()`. It MUST pass this config (and `linkSummary` if available) directly to `discoverMCPServers` / `getWorkspaceMCPStatus` rather than relying on those functions' optional-parameter fallbacks. The fallback in `discoverMCPServers` makes an internal HTTP call back to the daemon's own workspace config API (`client.workspace[":workspaceId"].config.$get()`), which is both unnecessary and wasteful when the handler already has the config in memory. The `workspaceConfig` parameter is optional for other consumers (e.g., the workspace chat agent which may not have a pre-loaded config), but the daemon route handler should always provide it.

### Test Chat: Why SSE Instead of WebSocket

SSE is chosen because:
1. The existing workspace chat infrastructure already uses SSE (via `streamText` + `ChatSDK`).
2. The test chat is request/response with server push — no bidirectional client→server messages after the initial POST.
3. Hono's streaming response support makes SSE trivial to implement.
4. No additional connection management (no WebSocket upgrade, no heartbeat).

### Test Chat: Why Single-Shot (No Multi-Turn)

The test chat is deliberately single-shot: each message is a completely independent exchange with no conversational memory. This was chosen for simplicity and safety:

1. **No session state to manage** — no in-memory maps, no TTL cleanup, no garbage collection concerns on long-running daemons.
2. **Simpler architecture** — no rate-limiting state, no session affinity, no per-user session stores.
3. **Matches the diagnostic intent** — the test chat answers "does this server's tool X work with my credentials?" not "can I have a prolonged conversation?" Multi-step workflow testing belongs in the actual workspace chat, which has full conversation history.

The tradeoff is that users cannot test follow-up interactions (e.g., "list tasks" → "create task from result #3"). This is an accepted limitation. If multi-turn testing is needed, the user should test in the workspace chat, or a future version could add in-memory session history.

### Connection Test vs Test Chat

The Connection Test (`/api/mcp/:id/tools`) is a lightweight probe: it resolves credentials, connects, and lists tools. It answers "is this server reachable and what can it do?" The Test Chat is a full LLM session: it answers "can I actually use this server to accomplish something?" Both are necessary — the first is diagnostic, the second is experiential.

### Error Phase Classification

The `/tools` and `/test-chat` endpoints classify connection failures into phases:
- `dns`: Hostname resolution failed (HTTP URL unreachable, stdio command not in PATH)
- `connect`: TCP/stdio connection established but handshake failed
- `auth`: Connection succeeded but authentication rejected (expired token, bad API key)
- `tools`: Connection + auth succeeded but `tools()` call failed (server protocol error, timeout)

This classification is approximate (derived from error message patterns) but sufficient for user-facing diagnostics. Exact classification may improve over time.

### Security Considerations

The test chat endpoint runs with the same privileges as the daemon (access to `process.env`, Link credentials, filesystem for stdio spawns). It does not sandbox the MCP server — a malicious stdio server could potentially access the daemon's environment. This is identical to the risk model of production MCP usage. The test chat is restricted to authenticated daemon users (same auth middleware as all other routes).

v1 does not implement rate limiting. A future version may add per-user per-server throttling via Deno KV.
- **`delete_mcp_server` chat tool**: Destructive catalog deletion is not exposed in workspace chat. Users must use the web UI or daemon API directly to remove a server from the global catalog.

### Why a System Skill + Tools, Not Just Tools

The conceptual boundary between "install" (global catalog) and "enable" (workspace scope) is non-obvious. Without the skill, the LLM would:
- Try `install_mcp_server` when the user says "add to workspace"
- Try `list_mcp_servers` when the user asks "what's active in this workspace"
- Use "delete" terminology for workspace removal

The skill encodes the domain vocabulary so the LLM reasons correctly before reaching for a tool. The tools encode the operational mechanics so the action is reliable and one-shot.

### Relationship to Existing MCP Tools in Workspace Chat

| Tool | Scope | Action | New? |
|---|---|---|---|
| `list_mcp_servers` | Global catalog | Discover all installed servers | Existing |
| `search_mcp_servers` | Global catalog | Search upstream registry | Existing |
| `install_mcp_server` | Global catalog | Install from registry | Existing |
| `create_mcp_server` | Global catalog | Create custom server | Existing |
| `get_workspace_mcp_status` | Workspace | List enabled vs available | **New** |
| `enable_mcp_server` | Workspace | Enable catalog server here | **New** |
| `disable_mcp_server` | Workspace | Disable server from here | **New** |

### FSM Cleanup Implementation Note

When `disableMCPServer` is called with `force: true`, it must strip the server ID from all FSM job action `tools` arrays. The existing `fsm-agents.ts` infrastructure supports path-based single-entry mutation only. A new bulk draft walker is needed: iterate all `config.jobs`, parse each FSM, walk `states[].entry[]`, and filter `tools` arrays in-place via `produce`. This is approximately 20 lines and is co-located with `disableMCPServer` in `packages/config/src/mutations/mcp-servers.ts`.

### Performance

- The tool probe and test chat both spin up fresh MCP connections. No pooling is implemented — this is intentional for simplicity and isolation. Each test is independent.
- The workspace MCP manager `GET` endpoint calls `discoverMCPServers` with workspace config explicitly passed (see "Performance: Pass workspaceConfig Explicitly" above), which reads catalog from memory (static) or Deno KV (dynamic). This is fast enough for UI rendering without caching.
- Enable/disable mutations write config atomically (temp file + rename) and invalidate relevant queries. Blueprint mutations (not in v1) would trigger a full recompile → write cycle via `saveAndRecompileBlueprint`.
- The workspace runtime picks up config changes on next load (no hot-reload in v1).
