# Workspace Activity Implementation Learnings

## Hono RPC Client Strict Typing
- Hono's zod-validator types the RPC client strictly against route schemas — you cannot pass extra fields in json/query without updating the route's Zod schema first
- When interface/adapter and route changes are in separate tasks, the client must defer passing new params until the route schema is updated
- Storm encountered this and correctly deferred `markViewedBefore.workspaceId` passthrough in the ledger client until task #2 updated the route schema

## TanStack Query Key Collisions
- When using the same query function at different scopes (e.g., limited preview vs full infinite scroll), use distinct query keys to avoid cache collisions
- Ferox used `workspace-activity-full` vs `workspace-activity` to separate the sub-page infinite query from the overview preview query

## `0 as number` in TanStack Query initialPageParam
- `createInfiniteQuery` infers `initialPageParam: 0` as literal type `0` not `number`, requiring `0 as number` for `getNextPageParam` arithmetic
- This is type widening, not an unsafe assertion — borderline against the `as` rule but standard TanStack pattern
