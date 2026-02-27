---
name: writing-svelte
description: Patterns and tools for writing Svelte 5 components in the web-client. Covers data fetching (Hono RPC, TanStack Query), state management (writable derived, props, effects), and component design. Load when creating or editing .svelte or .svelte.ts files.
---

# Svelte 5 Code Writer

## What Am I Doing?

| Activity                        | Load                                                                                                    |
| ------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Fetching data or calling APIs   | [references/data-fetching.md](references/data-fetching.md) — Hono client, TanStack Query, mutations    |
| Building components with state  | [references/state-patterns.md](references/state-patterns.md) — component-owned state, effects, props    |
| Syncing props to local state    | [references/writable-derived.md](references/writable-derived.md) — `let x = $derived(prop)` pattern     |
| Uncertain about Svelte 5 syntax | [references/svelte-mcp-cli.md](references/svelte-mcp-cli.md) — docs lookup, autofixer via `npx`        |

## CLI Tools

Use `@sveltejs/mcp` via `npx` when you need to look up Svelte 5 syntax or
validate a component. See [references/svelte-mcp-cli.md](references/svelte-mcp-cli.md)
for full usage.

- `npx @sveltejs/mcp list-sections` — list available doc topics
- `npx @sveltejs/mcp get-documentation "<sections>"` — fetch docs for a topic
- `npx @sveltejs/mcp svelte-autofixer <file>` — analyze a component for issues

## Core Rules

1. **Use the Hono RPC client for all API calls** — never raw `fetch` with
   `getAtlasDaemonUrl()`. The client at `@atlas/client/v2` provides type-safe
   routes.
2. **Use TanStack Query with SvelteKit load** — `+page.ts` fetches for SSR,
   `createQuery` in the component uses `initialData` from the load. Same query
   key ensures no double fetch. No `invalidateAll`.
3. **Use `createMutation` for writes** — tracks `isPending`, handles
   `onSuccess`. No manual `saving` flags.
4. **Components own their state** — pass `value` as a prop, let the component
   manage internal edits, receive changes via `onblur(value)` callbacks.
5. **Use `select` in queries** — unwrap response data at the query level, not in
   every consumer.

## Gotchas

- **Template type narrowing doesn't compose with discriminated unions** — Svelte
  templates can't narrow discriminated union variants inline. Extract and narrow
  data in `<script>` before passing to template expressions.
- **`$effect` vs `$effect.pre`** — `$effect` runs after DOM update (good for
  measuring DOM). `$effect.pre` runs before DOM update (good for syncing state
  before render). Prefer `$effect` unless you specifically need pre-render sync.
- **Don't duplicate query data into `$state`** — if a value comes from
  `createQuery`, use it directly via `$derived` or pass as a prop. Only use
  `$state` for values the user edits that aren't managed by a child component.

## Workflow

1. **Uncertain about syntax?** Run `list-sections` then `get-documentation`
2. **Reviewing/debugging?** Run `svelte-autofixer` on the file
3. **Always validate** — run `svelte-autofixer` before finalizing any component
