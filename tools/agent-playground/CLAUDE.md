# @atlas/agent-playground

Unified dev tool for agents and workspaces. SvelteKit + Hono with sidebar
navigation, route-based pages, and full RPC type safety.

## Running

```bash
deno task playground    # from monorepo root (http://localhost:5200)
deno task sim "prompt"  # headless CLI for workspace pipeline
```

The playground also ships as a compiled binary in Friday Studio — the static
SvelteKit build is served alongside the Hono `/api/*` router from a single
Deno entry point that gets `deno compile`'d into a `playground` binary.

## Architecture

- **SvelteKit** — UI framework, routing, SSR
- **Hono** — API layer at `/api/*`, forwarded via catch-all `+server.ts`
- **hc** (Hono Client) — typed RPC client, full type inference from router

API routes live in `src/lib/server/router.ts`. Route groups:

- `routes/agents.ts` — bundled agent metadata
- `routes/execute.ts` — bundled agent execution (SSE)
- `routes/mcp.ts` — MCP server discovery and tool listing
- `routes/workspace.ts` — workspace parse, execute (SSE), runs

Workspace pipeline logic in `src/lib/server/lib/workspace/`:

- `pipeline.ts` — four-phase pipeline (blueprint → compile → assemble → execute)
- `run-fsm.ts` — FSM execution harness
- `mock-executor.ts` / `direct-executor.ts` — mock vs real agent execution

## Routes

```
/agents/bundled       — bundled agent selector + execution
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

## Gotchas

- Never call `goto()` from `$effect` — it creates invisible infinite navigation
  loops that hang the browser with no errors. If state mirrors a URL param,
  use `$derived` from `page.url` instead of syncing `$state` via effects.
  See `docs/never-again/2026-04-02-effect-goto-loops.md`
