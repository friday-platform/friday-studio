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
