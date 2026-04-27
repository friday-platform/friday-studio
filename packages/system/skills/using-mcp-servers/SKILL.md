---
name: using-mcp-servers
description: Use when choosing between install, enable, disable, or delete for an MCP server; when an agent needs to discover or delegate to MCP servers; or when MCP tools fail with credential, connection, or prefixing issues.
user-invocable: false
---

# Using MCP Servers

## Overview

There are two contexts for MCP servers: **admin** (changing what exists) and
**chat** (using what exists). Agents in chat discover and use servers directly
from the platform catalog — no workspace enable step required. Workspace
enable/disable only controls `workspace.yml` overrides, not chat visibility.

## When to Use

- User asks to add, remove, enable, disable, or configure an MCP server
- Agent must choose between `search_mcp_servers`, `install_mcp_server`,
  `enable_mcp_server`, `disable_mcp_server`, or `delete_mcp_server`
- Agent needs MCP tools inside a `delegate` sub-agent
- MCP connection fails or tool names collide across servers

## Two contexts

| Context | Who asks | What changes | Key rule |
|---------|----------|--------------|----------|
| Admin | User talking to settings / UI | Catalog or workspace config | `install`/`delete` mutate the catalog; `enable`/`disable` mutate workspace YAML |
| Chat | Agent during a conversation | Nothing — uses existing servers | `list_mcp_servers` discovers all catalog servers. `enable` is irrelevant. |

**Critical:** Chat agents do not need `enable_mcp_server` to see or use a
catalog server. `enable` only adds workspace-level overrides or custom
servers to `workspace.yml`.

## Admin path: choosing the right tool

| User says | Tool | Why |
|-----------|------|-----|
| "Install X from the registry" / "Search for X" | `search_mcp_servers` → `install_mcp_server` | Adds to the platform catalog |
| "Add X to this workspace" | If X is in catalog: `enable_mcp_server(X)` | Copies into `workspace.yml` for non-chat uses (FSM jobs, bundled agents) |
| "Remove X from this workspace" | `disable_mcp_server(X)` | Removes from `workspace.yml`. Catalog entry stays. |
| "Delete X entirely" / "Uninstall X" | `delete_mcp_server(X)` | Destructive — removes from catalog. Only for custom/user-created servers. |

- **"Add" is ambiguous.** Ask: add to catalog (`install`) or add to workspace
  YAML (`enable`)? Chat agents don't need either.
- **"Remove" vs "Delete" is ambiguous.** Ask: remove from workspace (`disable`)
  or delete from catalog (`delete`)?
- **Disable is safe by default.** Returns 409 + `willUnlinkFrom` if agents/jobs
  reference it. Surface the list, ask the user, retry with `force: true`.

## Chat path: delegation with MCP tools

1. **Discover:** `list_mcp_servers` — returns all available servers with
   `configured: true/false`.
2. **Connect if needed:** If `configured: false` and `provider` is present, call
   `connect_service(provider)`. The UI will fire `data-credential-linked` when
   the user finishes.
3. **Auto-continue:** On `data-credential-linked`, re-call `list_mcp_servers` to
   confirm `configured: true`, then `delegate` with `mcpServers: [id]` and the
   original goal.
4. **Delegate:** `delegate` validates IDs fail-fast. Unknown or unconfigured
   IDs return `ok: false` before any connection attempt.
5. **Tool naming:** Child gets prefixed tools (`strava_getActivity`) when 2+
   servers are selected; unprefixed (`getActivity`) when 1.
6. **Graceful degradation:** One failed server does not kill the child.
   `serverFailures` surfaces reasons to the parent.

## Common Mistakes

| Mistake | Why it happens | Fix |
|---------|---------------|-----|
| Calling `enable` so chat can use a server | Confusing workspace YAML with chat discovery | Catalog servers are visible to `list_mcp_servers` without enable. |
| Calling `delete` when user said "remove from workspace" | Confusing catalog deletion with workspace disable | "Remove from workspace" = `disable`. "Delete from catalog" = `delete`. |
| Calling `install` when user said "add to workspace" | Catalog installation does not wire into workspace YAML | Check catalog first. If present, ask: install (catalog) or enable (workspace YAML)? |
| Delegating without calling `list_mcp_servers` | LLM assumes server IDs from stale prompt | Always list first. Validate IDs server-side. |
| Ignoring `configured: false` | Async credential check is accurate | Prompt user to `connect_service`. Do not attempt connection. |
| Re-enabling a custom server after disable | Custom servers have no catalog backing | Re-enable requires manual YAML editing. Say this explicitly. |

## Quick diagnostic

1. User says "I don't see X" → `list_mcp_servers`. If it's there but
   `configured: false` → `connect_service`.
2. User says "Add X to workspace" → Check if X is in catalog. If yes, ask:
   chat already sees it — do you mean enable for workspace YAML?
3. Disable fails → Surface `willUnlinkFrom`, confirm, retry with `force: true`.
