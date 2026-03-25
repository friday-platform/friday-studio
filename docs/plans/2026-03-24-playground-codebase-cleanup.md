# Playground Codebase Cleanup

Shipped 2026-03-24 on `eric/playground-cleanup-v2`. Transparent refactor of
`@atlas/agent-playground` — tightened the codebase without impacting
functionality. 116 files changed, net −1302 LOC across 7 incremental moves.

## What Changed

### SSE Stream Parser (`src/lib/utils/sse.ts`)

Extracted duplicated `ReadableStream → typed events` pipeline into a shared
`parseSSEEvents<T>()` async generator. Six consumers migrated from inline
parsing to `for await` loops. Cancellation pattern normalized to
`activeStream.cancel()` across all execution components.

### Query Option Factories (`src/lib/queries/`)

Replaced custom hook abstractions with `queryOptions`-based factories split by
domain: `agent-queries.ts`, `integration-queries.ts`, `session-queries.ts`,
`skill-queries.ts`, `workspace-queries.ts`. All daemon queries standardized on
typed Hono RPC client. `skipToken` adopted to eliminate non-null assertions at
nullable/non-nullable boundaries. Mutation invalidation tightened to specific
keys.

### @atlas/ui Component Consolidation

Replaced playground-local duplicates with `@atlas/ui` exports:
- Local `markdown.ts` (356 LOC) + `markdown.css` (188 LOC) → `@atlas/ui`
  `markdownToHTML` + `MarkdownRendered`
- Custom status pills → `StatusBadge` (gained `pending` variant)
- Inline SVG icons → `Icons`/`IconSmall` components
- Dead CSS (scoped `:global(.class) svg` selectors) cleaned up

### ExecutionStatus Discriminated Union (`src/lib/types/execution-status.ts`)

Replaced `executing`/`cancelled` boolean pairs with a single discriminated
union: `idle | running | cancelled | complete | error`. Folded `activeReader`
into the `running` variant. Components use `$derived(execution.state === ...)`
instead of boolean checks.

### Component Decomposition

Extracted `AgentReferencePanel` from `agent-workbench.svelte`. Separated
`ExecutionStream` and `OutputTabs` into standalone components with
`ExecutionStatus` props instead of boolean flags.

### Zod Schema Replacements

Added `JsonSchemaObjectShape` / `JsonSchemaPropertyShape` schemas to
`schema-utils.ts`. Replaced `as Record<string, unknown>` chains in
`contract-checker.ts`, skill query responses, and schema display components.

### Feature Directory Organization

Moved 55 components from flat `src/lib/components/` into feature directories:
`agents/`, `execution/`, `inspector/`, `session/`, `shared/`, `skills/`,
`workspace/`. All import paths updated.

### Dead Code Deletion

Deleted unreachable `/agents/custom` route and 4 exclusive supporting components
(1046 LOC). Route had no sidebar link, no href, no `goto` reference.

## Key Decisions

**`queryOptions` factories over custom hooks.** Custom hooks lock callers into
`createQuery` and break type inference. Factories are composable — spread at
call site, works with `prefetchQuery`, `getQueryData`, `useSuspenseQuery`
without rewriting. TKDodo's recommended pattern.

**`skipToken` over `enabled` + non-null assertions.** TanStack Query's
`skipToken` sentinel replaces the `enabled: !!id` + `queryFn: () => fn(id!)`
pattern. Eliminates the `!` assertions at the nullable boundary entirely.

**Feature directories over domain modules.** Chose directory-per-feature
(`agents/`, `workspace/`) over a deeper module extraction. Components share
state through props and query factories, not co-located stores. The `shared/`
directory holds truly cross-cutting components (sidebar, schema display, etc.).

**ExecutionStatus union over state machine.** A simple discriminated union
(`idle | running | cancelled | complete | error`) was sufficient — no need for
FSM formalism. The reader lives in the `running` variant because it's only
meaningful when executing.

## Out of Scope

- **Dialog `writable()` migration** — `Dialog.Root` from `@atlas/ui` wraps Melt
  UI's `createDialog` which requires `Writable<boolean>`. Needs `@atlas/ui` to
  migrate Dialog to Svelte 5 bindable props first.
- **Inspector `$effect` anti-patterns** — Three effects use previous-value
  comparison for bidirectional URL ↔ state sync. Correct but fragile. Needs a
  URL-state sync primitive to refactor safely.
- **`collapsible-section.svelte` extraction** — Domain-specific (localStorage
  persistence, disclosure triangles, summary badges). Not a duplicate of
  `@atlas/ui` Collapsible.
- **Decomposing remaining large components** — `cheatsheet.svelte` (722 LOC),
  `skill-loader.svelte` (704), `cockpit-view.svelte` (531), `signal-row.svelte`
  (509) are candidates for future decomposition.
- **`agent-workbench.svelte` further decomposition** — Schema panels and run
  history could be extracted. Left as-is after initial extraction pass.
