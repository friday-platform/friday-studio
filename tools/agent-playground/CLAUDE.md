# @atlas/agent-playground

Unified dev tool for agents and workspaces. SvelteKit + Hono with sidebar
navigation, route-based pages, and full RPC type safety.

## Running

```bash
deno task playground    # from monorepo root (http://localhost:5200)
deno task sim "prompt"  # headless CLI for workspace pipeline
```

Always run in dev mode. No build step needed — this is a local dev tool.

## Architecture

- **SvelteKit** — UI framework, routing, SSR
- **Hono** — API layer at `/api/*`, forwarded via catch-all `+server.ts`
- **hc** (Hono Client) — typed RPC client, full type inference from router

API routes live in `src/lib/server/router.ts`. Route groups:

- `routes/agents.ts` — bundled agent metadata
- `routes/execute.ts` — bundled agent execution (SSE)
- `routes/custom.ts` — custom agent execution (SSE)
- `routes/mcp.ts` — MCP server discovery and tool listing
- `routes/workspace.ts` — workspace parse, execute (SSE), runs

Workspace pipeline logic in `src/lib/server/lib/workspace/`:

- `pipeline.ts` — four-phase pipeline (blueprint → compile → assemble → execute)
- `run-fsm.ts` — FSM execution harness
- `mock-executor.ts` / `direct-executor.ts` — mock vs real agent execution

## Routes

```
/agents/bundled       — bundled agent selector + execution
/agents/custom        — custom agent config + execution
/workspaces           — workspace inspector (load YAML or generate)
/workspaces/history   — past pipeline runs
```

## Adding API Routes

Add routes to `src/lib/server/routes/`, mount in `router.ts`. The `Router` type
export updates automatically — `hc<Router>()` picks up new routes with full type
inference.

## Conventions

- `console.*` is allowed — dev tool exemption from `@atlas/logger` rule
- No production deployment — local only
- Components use Svelte 5 runes (`$state`, `$derived`, `$effect`, `$props`)
- Design tokens from `@atlas/ui/tokens.css`
- Use `makeClient(fetch)` in load functions, `getClient()` in browser code
