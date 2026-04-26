---
name: mcp-workspace-management
description: "Teach workspace-chat the mental model of MCP server catalog vs workspace-scoped enablement. Use when the user asks to add, remove, enable, disable, or configure MCP servers in a workspace."
user-invocable: false
---

# MCP Workspace Management

Bridge the gap between the global MCP catalog and workspace-scoped tool
availability. Users install servers into the platform catalog, but agents
inside a workspace can only use servers that are explicitly enabled in that
workspace's `tools.mcp.servers` config.

This skill teaches the four actions, four scopes mental model so the LLM
picks the right tool and avoids destructive mistakes.

---

## Four actions, four scopes

| Action | Scope | Tool | What it does |
|--------|-------|------|--------------|
| Search / install | Global catalog | `search_mcp_servers`, `install_mcp_server` | Makes a server available platform-wide. Does **not** make it available to agents in any workspace. |
| Enable | Workspace | `enable_mcp_server` | Copies the server's `configTemplate` into `workspace.yml` under `tools.mcp.servers.{id}`. The server is now available to agents in this workspace. Idempotent — calling it again succeeds with no mutation. |
| Disable | Workspace | `disable_mcp_server` | Removes the server from `tools.mcp.servers` in this workspace. The server remains in the catalog. Safe by default (refuses if referenced by agents/jobs); use `force` to override. |
| Delete | Global catalog | `delete_mcp_server` (not yet implemented in chat tools) | Destructive — removes the server from the catalog entirely. Only appropriate for custom servers the user created. |

---

## When to use which

- **User says "add X to this workspace"**
  - If X is already in the catalog → `enable_mcp_server(X)`.
  - If X is NOT in the catalog → `install_mcp_server` (registry) or `create_mcp_server` (custom) first, then `enable_mcp_server(X)`.

- **User says "remove X from this workspace"**
  - → `disable_mcp_server(X)`. Do **not** use `delete` — that destroys the catalog entry.

- **User says "I don't see X in my workspace"**
  - → `get_workspace_mcp_status` to check if it's in `enabled` or `available`.

- **User says "uninstall X" or "delete X"**
  - → Clarify: from the workspace (`disable`) or from the catalog (`delete`)?

- **User says "which MCP servers are active here?"**
  - → `get_workspace_mcp_status`. Only list `enabled` servers — `available` servers are not wired into agents yet.

---

## Reference safety and the `force` confirmation pattern

`disable_mcp_server` without `force` returns 409 + `willUnlinkFrom` listing the
agents and jobs that still reference the server. The LLM must surface this list
and ask the user to confirm before proceeding.

If the user confirms, retry with `force: true`. This removes the server from
workspace config and strips all references from:
- Top-level LLM agent `tools` arrays (`config.agents.{id}.config.tools`)
- FSM job step `tools` arrays (`config.jobs.{id}.fsm.states[].entry[].tools`)

Blueprint workspaces route through the blueprint recompile path — the tool
handles this transparently and returns 422 if direct mutation is not allowed.

---

## Custom servers

Servers with `source: "workspace"` appear in `enabled` but have no catalog
backing. They can be disabled like any other, but re-enabling requires manual YAML editing (the LLM should say this explicitly).

---

## Quick diagnostic workflow

1. `get_workspace_mcp_status` — see what's enabled vs available.
2. If the desired server is in `available`, call `enable_mcp_server(id)`.
3. If `configured: false`, credentials are missing — direct the user to the
   MCP detail page to connect credentials, then retry enable.
4. If disabling fails with 409, surface `willUnlinkFrom`, ask for confirmation,
   and retry with `force: true` if approved.
