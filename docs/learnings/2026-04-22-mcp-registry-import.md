# MCP Registry Import — Team Lead Learnings

## Session Start
- Branch: `mcp-registry-import`
- Design doc: docs/plans/2026-04-22-mcp-registry-import-design.v4.md
- 8 tasks across 4 waves, all completed
- 10 commits (7 features, 1 pre-existing fix, 2 review fixes)
- 101 tests passing across 5 test files

## Observations

### Recurring Mistakes (Multiple Teammates)

1. **`as` type assertions on JSON responses.** Both Task 45 (upstream client tests) and Task 50 (Svelte catalog page) used `as` to cast `await res.json()` instead of Zod `.parse()`. The existing codebase has this pattern in some places (skills.ts, skills-sh-import.svelte), which teammates copy. **Action:** The hard rule is clear but existing code sends mixed signals. A one-time cleanup of legacy `as` assertions in query hooks would remove the bad example.

2. **`e as Error` in catch blocks.** Used by both Task 49 (query hooks) and Task 50 (Svelte page). Same root cause as above — copied from skills-sh-import.svelte. **Action:** Same cleanup needed.

3. **Forgetting to remove unused imports after refactoring.** Task 48 removed `GET /servers` tests from `mcp.test.ts` but left the `mcpServersRegistry` import. Task 47's tests had an unused `_unused` variable. **Action:** Remind teammates: when you delete code that uses an import, delete the import too. Lint won't catch unused imports in test files under vitest.

4. **Dynamic imports where static imports work.** Task 50 used `await import("$lib/daemon-client.ts")` inside a queryFn instead of static import at top. **Action:** Static imports only — no runtime dynamic imports unless there's a genuine code-splitting need.

### Codebase Quirks That Confused Teammates

5. **`deno check` does NOT check `.svelte` files.** Returns "No matching files found." Svelte type checking requires `svelte-check` via `deno task typecheck`. We only discovered a type issue in `+page.svelte` by visual review, not by tooling. **Action:** For Svelte tasks, add a note to run `deno task typecheck` or at least read the file carefully for import paths and `as` assertions.

6. **Hono RPC client expects string query parameters.** `limit: 20` (number) causes a type error; `limit: "20"` (string) is required. Teammate fixed this during review. **Action:** Document this gotcha — Hono's `zValidator("query", ...)` with `z.coerce.number()` may accept numbers at runtime but the RPC client types expect strings.

7. **`MCPServerMetadata` is not exported from `$lib/queries`.** Task 50 tried to import it from the queries barrel. The index.ts only re-exports query-related symbols, not core schema types. **Action:** Remind teammates to import core types from their source packages (`@atlas/core/mcp-registry/schemas`), not from convenience barrels.

### Design Doc Deviations That Worked Out

8. **Adapter `update()` returns `null` on missing entry instead of throwing.** The design doc AC said "throws if the entry does not exist" but the teammate implemented `MCPServerMetadata | null`. This turned out to be the better API — it's consistent with `get()` returning `null`, and the route can distinguish "not found" from "concurrent modification" (which does throw). No downstream issues. **Decision:** Keep the deviation.

9. **Adapter `update()` takes `(id, Partial<Updatable>)` instead of `(entry)`.** The design doc said `update(entry: MCPServerMetadata)` but the teammate did `update(id, changes)` excluding immutable `id`/`source`. This is actually better for the pull-update use case where you want to preserve the stored ID. The route destructures `{ id, source, ...rest } = translatedEntry` and passes `rest`. **Decision:** Keep the deviation; update design doc if it becomes canonical.

### Positive Patterns

10. **Fixture-driven translator tests are excellent.** 36 tests with realistic upstream JSON blobs made review trivial — every reject branch is exercised with a concrete input. This pattern should be encouraged for future schema translation tasks.

11. **In-memory KV + vi.mock pattern scales well.** All 4 integration test files (daemon routes, playground routes, adapter, upstream client) used the same `Deno.openKv(":memory:")` + `vi.mock` pattern with zero flakiness. This is a proven template.

12. **Teammate rotation matters.** Fresh teammates on Tasks 46, 48, 50 produced higher-quality first drafts than if we had piled 4+ tasks on a single agent. The context window degrades visibly after 2-3 tasks.
