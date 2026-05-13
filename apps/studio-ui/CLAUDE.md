# @atlas/agent-playground

Unified dev tool for agents and workspaces. SvelteKit + Hono with sidebar
navigation, route-based pages, and full RPC type safety.

## Running

```bash
deno task playground    # from monorepo root (http://localhost:5200)
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
- `routes/updates.ts` — Studio version check (`GET /`, `POST /check`)
- `routes/discover.ts` — workspace discovery + bundle import
- `routes/shell.ts` — shell command execution

## Routes

```
/agents/bundled       — bundled agent selector + execution
/platform/[wsId]      — workspace inspector
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

## Update-check env vars

Read by `src/lib/server/lib/update-checker.ts` for local iteration on the
update banner / Settings panel without rebuilding the installer or hitting
the live CDN:

- `FRIDAY_UPDATE_VERSION_OVERRIDE` — pretend Studio is running this version
  (top of the resolution chain; wins over the `.studio-version` sidecar).
- `FRIDAY_UPDATE_MANIFEST_URL` — point the checker at a fixture server
  (e.g. `http://localhost:9999/studio/manifest.json`) instead of
  `https://download.fridayplatform.io/studio/manifest.json`.
- `FRIDAY_UPDATE_FORCE` — at startup only, treat the persisted
  `lastCheckedAt` as null so the warm-up schedules a fresh check 30s..5min
  after boot. Does NOT bypass the `POST /api/updates/check` 10s rate limit.

## Gotchas

- Never call `goto()` from `$effect` — it creates invisible infinite navigation
  loops that hang the browser with no errors. If state mirrors a URL param,
  use `$derived` from `page.url` instead of syncing `$state` via effects.
  See `docs/never-again/2026-04-02-effect-goto-loops.md`
