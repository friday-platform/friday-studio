# Spec: `list_mcp_tools` tool for workspace-chat

## Problem

From the transcript `chat_pwC2juu47H`:

- Agent guesses tool names (`gmail_list_messages`, `gmail_get_message`, etc.)
- Validator rejects them as `unknown_tool` because it cannot resolve them against the draft's MCP config
- Agent burns 6+ tool calls trying to introspect the `workspace-mcp` package via `find`, `grep`, `uvx` — all failing
- Agent never publishes because it can't validate tool names

Root cause: **no first-class way for the agent to discover what tools an MCP server exposes.**

## Existing infrastructure

The daemon already has exactly what we need:

```
GET /api/mcp-registry/:id/tools
```

Implementation in `apps/atlasd/routes/mcp-registry.ts` (~line 680):

1. Looks up the server in the consolidated registry (static blessed or workspace-imported)
2. Calls `createMCPTools({ [id]: server.configTemplate }, logger, { signal: AbortSignal.timeout(5000) })`
3. Maps `result.tools` entries to `{ name, description? }`
4. Calls `result.dispose()` to clean up the spawned process
5. Returns `{ ok: true, tools: [...] }`
6. On failure, classifies error into phase: `dns | connect | auth | tools`

The web client already proxies this:
```
GET /api/daemon/api/mcp-registry/com-notion-mcp/tools
```

The Hono client already exposes it:
```ts
client.mcpRegistry[":id"].tools.$get({ param: { id: "google-gmail" } })
```

## What we need to build

A workspace-chat tool that calls the existing endpoint and returns a structured result the LLM can act on.

### Tool spec

**Name:** `list_mcp_tools`

**Description:**
> Spin up an MCP server and list the exact tool names it exposes. Use this before writing an agent config that references MCP tools — it tells you the precise tool names to put in the agent's `tools` array. The server is started temporarily and shut down immediately; no workspace state is modified.

**Input schema:**
```ts
z.object({
  serverId: z.string().min(1).describe(
    "ID of the MCP server to probe (e.g. 'google-gmail', 'github', 'com-notion-mcp'). " +
    "Use list_mcp_servers or search_mcp_servers to find valid IDs."
  ),
})
```

**No `workspaceId` parameter.** The tool probes the global registry template, not a workspace-resolved config. Tool names are invariant across workspaces — a Gmail server always exposes the same tool names regardless of whose credentials are attached.

**Return type:**
```ts
// Success
{
  ok: true,
  tools: Array<{
    name: string;
    description?: string;
  }>;
}

// Failure — classified so the agent knows whether to retry, fix credentials, or give up
{
  ok: false;
  error: string;
  phase: "dns" | "connect" | "auth" | "tools";
}
```

**Phase guidance for the skill:**
- `dns` — server URL/domain unreachable (registry entry may be stale)
- `connect` — server process starts but the transport endpoint is unreachable
- `auth` — credentials missing or expired; call `connect_service` before retrying
- `tools` — server started but `tools/list` timed out or returned malformed data; retry once

## Implementation

### New file: `packages/system/agents/workspace-chat/tools/list-mcp-tools.ts`

Follows the exact pattern of `enable-mcp-server.ts` and `list-mcp-servers.ts`:

```ts
import type { AtlasTools } from "@atlas/agent-sdk";
import { client } from "@atlas/client/v2";
import type { Logger } from "@atlas/logger";
import { tool } from "ai";
import { z } from "zod";

const ListMcpToolsInput = z.object({
  serverId: z.string().min(1).describe("..."),
});

const ToolItemSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
});

export interface ListMcpToolsSuccess {
  ok: true;
  tools: Array<{ name: string; description?: string }>;
}

export interface ListMcpToolsError {
  ok: false;
  error: string;
  phase: "dns" | "connect" | "auth" | "tools";
}

export function createListMcpToolsTool(logger: Logger): AtlasTools {
  return {
    list_mcp_tools: tool({
      description: "Spin up an MCP server and list...",
      inputSchema: ListMcpToolsInput,
      execute: async ({ serverId }): Promise<ListMcpToolsSuccess | ListMcpToolsError> => {
        try {
          const res = await client.mcpRegistry[":id"].tools.$get({
            param: { id: serverId },
          });
          const body = await res.json();

          if (res.status === 200) {
            const parsed = z
              .object({
                ok: z.literal(true),
                tools: z.array(ToolItemSchema),
              })
              .safeParse(body);

            if (parsed.success) {
              logger.info("list_mcp_tools succeeded", { serverId, toolCount: parsed.data.tools.length });
              return { ok: true, tools: parsed.data.tools };
            }

            logger.warn("list_mcp_tools: unexpected success shape", { serverId, body });
            return { ok: false, error: "Unexpected response shape from MCP registry", phase: "tools" };
          }

          if (res.status === 404) {
            return {
              ok: false,
              error: `MCP server "${serverId}" not found in catalog. Use search_mcp_servers or list_mcp_servers to find valid IDs.`,
              phase: "connect",
            };
          }

          // Error responses from the probe endpoint are still 200 with ok:false,
          // but handle non-200 defensively.
          const fallback =
            typeof body === "object" && body !== null && "error" in body
              ? String(body.error)
              : `Probe failed: HTTP ${res.status}`;
          return { ok: false, error: fallback, phase: "tools" };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logger.warn("list_mcp_tools threw", { serverId, error: message });
          return { ok: false, error: `Probe failed: ${message}`, phase: "tools" };
        }
      },
    }),
  };
}
```

### Registration

In `workspace-chat.agent.ts`:

1. Add import:
   ```ts
   import { createListMcpToolsTool } from "./tools/list-mcp-tools.ts";
   ```

2. Instantiate alongside other MCP tools (around line ~740):
   ```ts
   const listMcpToolsTool = createListMcpToolsTool(logger);
   ```

3. Add to `primaryTools`:
   ```ts
   ...listMcpToolsTool,
   ```

### Test file: `packages/system/agents/workspace-chat/tools/list-mcp-tools.test.ts`

Follow the pattern of `enable-mcp-server.test.ts`:

- Mock `client.mcpRegistry` return shapes
- Test success (tools returned)
- Test 404 (unknown server)
- Test 200 with `ok: false` + phase (probe failure)
- Test thrown exception

## Skill update

Update `packages/system/skills/workspace-api/SKILL.md` (the skill loaded by `load_skill`):

Add to the **MCP Management** section, after step 2 (enable server):

> **2b. Discover tool names**
>
> Before adding an agent that uses MCP tools, call `list_mcp_tools({ serverId })` to get the exact tool names the server exposes. Use these names verbatim in the agent's `tools` array. Do not guess tool names.
>
> Example: `list_mcp_tools({ serverId: "google-gmail" })` returns `[{ name: "gmail_list_messages", description: "..." }, ...]` — use `"gmail_list_messages"` in the agent config.

Update the **Top gotchas** section:

> 5. **Always call `list_mcp_tools` before referencing MCP tools in an agent.** Tool names are not predictable — they come from the server implementation, not the server ID. Guessing produces `unknown_tool` validation errors.

## Why this fixes the transcript

In `chat_pwC2juu47H`, the agent's failure chain was:

1. Enable Gmail MCP → worked (in current workspace, not target — separate bug)
2. Upsert agent with guessed tool names → `unknown_tool` errors
3. Try to fix by reading current workspace config → copied OAuth secrets into draft
4. Try to introspect workspace-mcp package → 6 failed bash calls
5. Still can't validate → never publishes

With `list_mcp_tools`, the new chain is:

1. `list_mcp_tools({ serverId: "google-gmail" })` → returns exact tool names
2. Upsert agent with verified tool names → no `unknown_tool` errors
3. Publish → works

## Out of scope

- **Workspace-resolved config probing.** The current daemon endpoint uses `server.configTemplate`, not workspace-merged config. This is correct for tool name discovery — names don't vary by workspace. If we later need to verify workspace-specific env vars or auth work, that's a separate `test_mcp_server` concern.
- **Caching.** The endpoint spins up the server every time. For a 5-second probe this is fine. If latency becomes an issue, we can add a short-lived cache in the daemon later.
- **Bulk probe.** One server per call. The LLM can parallelize if multiple servers are needed.

## Acceptance criteria

- [ ] `list_mcp_tools.ts` implemented with error classification
- [ ] Registered in `workspace-chat.agent.ts`
- [ ] Unit tests cover success, 404, probe failure, and exception paths
- [ ] `workspace-api` skill updated with tool-discovery guidance
- [ ] QA case: build Inbox-Zero workspace — agent calls `list_mcp_tools` for Gmail before upserting agents, publishes without `unknown_tool` errors
