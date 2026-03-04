# atlasd

Atlas daemon — HTTP API server for the platform.

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
