# atlasd

Atlas daemon — HTTP API server for the platform.

## User-agent (.py) spawn resolution

`apps/atlasd/src/agent-spawn.ts` resolves the command for spawning Python
user agents in three tiers, top to bottom:

1. **`FRIDAY_UV_PATH` + `FRIDAY_AGENT_SDK_VERSION` set** → spawn via
   `uv run --python 3.12 --with friday-agent-sdk==<version> agent.py`.
   Production path. Set by the launcher (`tools/friday-launcher/project.go`)
   and the docker image. Pinned SDK lives in
   `tools/friday-launcher/paths.go` (`bundledAgentSDKVersion`) — same
   constant in `Dockerfile` (`FRIDAY_AGENT_SDK_VERSION` ENV).
2. **`FRIDAY_AGENT_PYTHON` set** → spawn that interpreter directly. Manual
   override for debugging against a hand-built venv.
3. **Neither set** → bare `python3` from PATH. Dev fallback. Assumes the
   dev has `friday_agent_sdk` importable in their environment.

Most in-tree dev should run `bash scripts/setup-dev-env.sh` once, which
writes the env vars in tier 1 to `<friday-home>/.env` and pre-warms uv's
cache. The script is idempotent and intentionally separate from the
installer flow.

## Liveness listener

The daemon binds TWO `Deno.serve` listeners, not one:

- **Main** on `--port` (default 8080) — full Hono app: agents, MCP,
  workspaces, chat, the lot. `/health` route lives here and is what
  atlas-cli + the playground UI hit.
- **Liveness** on `--health-port` (default `<port>+1` = 8081) — a single
  static `() => new Response("ok")` handler bound by `startHealthListener`
  in `src/atlas-daemon.ts`. No Hono, no middleware, no shared state.

The launcher's readiness probe targets the **liveness** port, not main
`/health`. Reason: when MCP fan-out / NATS-request storms saturate the
main listener's accept queue or pile slow handlers ahead of the probe,
the trivial `/health` route can fail the launcher's 2 s probe deadline.
30 consecutive failures × 2 s = SIGTERM → forced restart. The
dedicated socket (a) bypasses Hono routing + the `app.use("*", ...)`
request-logger middleware, (b) has its own TCP accept queue, and
(c) is immune to per-route regressions on the main app.

The two listeners share one V8 isolate, one event loop, one microtask
queue. **Under genuine CPU starvation neither handler dispatches** —
this design doesn't claim otherwise. The wins are routing/middleware
overhead and accept-queue isolation, not microtask-queue priority.

Disabling: pass `--health-port` equal to `--port`; `startHealthListener`'s
equal-port guard short-circuits without binding. The launcher never
needs this, but it lets tests / embedded callers run single-listener.

The synthetic resilience test is at `src/health-listener.test.ts` —
saturates a mock main listener with 64 in-flight slow handlers and
times the liveness probe (must complete in <500 ms with 1500 ms deadline).

## Gotchas

### Hono RPC Type Inference

- `.put(path, validator, handler)` overload infers Input type from the LAST
  handler — if that handler has an explicit `Context<E>` annotation (without I
  param), input collapses to `BlankInput` and the client loses json body types.
  Fix: wrap in `(c) => handler(c)` to let TS infer from middleware
- `.route()` called as a separate statement (not chained) is runtime-only —
  `typeof app` doesn't capture the mounted routes for RPC client types
- `$get()` requires the query/param argument object even when all fields are
  optional — pass `{ query: {} }` for routes with optional-only query params
- Route handlers returning `unknown[]` via `c.json()` produce `JSONValue[]` on
  the RPC client — parse data with Zod at the route boundary to get precise
  types
