# Learnings: Signal Details Schedule Editor

## Key Learnings

- Hono RPC types don't include `json` for routes using `createMutationHandler` with manual body parsing — `configClient.signals[":signalId"].$put({ param, json })` works at runtime but svelte-check reports a type error. Same pattern visible in integration-table.svelte. Not a regression.
- `deno check` can't check `.svelte` files directly — use `npx svelte-check` from the web-client directory instead.
- `structuredClone` is a clean way to snapshot `$state` objects for optimistic rollback without external libs.
- Fire-and-forget `persist()` calls (async without await) work for optimistic updates but create a subtle race: rapid state changes can overwrite the rollback snapshot before the first API call resolves. Fine for user-initiated dropdown clicks but worth noting if persistence moves to debounced/batched patterns later.
- `typeChangeError` import in `packages/config/src/mutations/signals.ts` was only used by the provider type guard — removing the guard required removing the import too, or lint fails on unused import.
