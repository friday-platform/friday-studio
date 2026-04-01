# Learnings: HubSpot Deterministic Ops (2026-03-31)

## Zod v4 JSON Schema

- `z.record(z.string(), z.unknown())` emits a `propertyNames` keyword in `z.toJSONSchema()` output, which the FSM engine sanitizer strips — breaks registry compatibility tests. `z.object({}).catchall(z.unknown())` produces the same TS type (`Record<string, unknown>`) without `propertyNames`. Should be added to CLAUDE.md Zod v4 gotchas.

## AI SDK v5

- `tool()` returns `execute` as optional in the type signature even when always provided at runtime — callers of deterministic dispatch need a guard (`if (!toolDef.execute)`) or the `getExecute` helper from `tools.test.ts`.

## Discriminated Union Behavior

- `z.discriminatedUnion` `safeParse` rejects unknown discriminator values with a validation error (not a separate code path). Unknown operation names and missing fields both surface as "Invalid operation" errors from the same branch. Tests should assert on the error message pattern, not assume distinct error paths.
