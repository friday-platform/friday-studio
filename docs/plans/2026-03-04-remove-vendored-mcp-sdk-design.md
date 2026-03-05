<!-- Source of record — consolidated after implementation -->

# Remove Vendored MCP SDK

## What & Why

Replaced `@socotra/modelcontextprotocol-sdk` (deprecated fork) with the official
`@modelcontextprotocol/sdk@^1.27.0` and `@atlas-vendor/hono-mcp` (vendored due
to Zod v3 peer dep) with `@hono/mcp@^0.2.4`. Both vendoring decisions became
obsolete when the official packages added Zod v4 support.

## What Changed

### Alias swap (4 packages)

`packages/{mcp,mcp-server,core,fsm-engine}/package.json` — replaced
`"npm:@socotra/modelcontextprotocol-sdk@^1.18.0"` alias with `"^1.27.0"`.
76+ import sites needed zero changes (alias already used canonical paths).

### Direct dependency + import rewrite (apps/link)

`apps/link/package.json` and `deno.json` — swapped `@socotra` dep. 5 provider
files (`linear`, `notion`, `hubspot`, `sentry`, `atlassian`) rewritten from
`@socotra/modelcontextprotocol-sdk/*` to `@modelcontextprotocol/sdk/*`.

### Un-vendor @hono/mcp (apps/atlasd)

`apps/atlasd/package.json` — `@atlas-vendor/hono-mcp: workspace:*` →
`@hono/mcp: ^0.2.4`. One import rewrite in `atlas-daemon.ts`.

### Vendored package deletion

Deleted `packages/vendor/hono-mcp/` (4 files, 674 lines). Removed
`packages/vendor/*` from root `package.json` workspaces and both
`packages/vendor/**` entries from `deno.json` exclude/lint.exclude.

### SDK API adaptation

Official SDK v1.27.0 changed `McpServer` constructor — `capabilities` moved from
first arg to second arg (options). `notifications` removed from
`ServerCapabilities` (fork-only addition). Fixed in `packages/core/src/agent-server/server.ts`
and `packages/mcp-server/src/platform-server.ts`.

## Out of Scope

- New MCP protocol features (tasks, elicitation)
- `@ai-sdk/mcp` StdioMCPTransport dependency (separate concern)
