# Learnings: Skills UI API Integration

## Session: 2026-02-25
## Branch: david/tem-3772-view-and-edit-skills-in-the-ui

- `deno check` with multiple entry points sharing recursive Zod types triggers TS2589 — check files individually to avoid false positives. Already documented in CLAUDE.md but teammates kept hitting it.
- When a Hono route uses `c.req.json()` / `c.req.parseBody()` split (multipart vs JSON), Hono RPC can't infer the body type for the JSON path. Use direct `fetch` with Zod response parsing instead.
- Biome lint auto-fixes import ordering — teammates placing exports out of alphabetical order get auto-corrected, but commit the fmt changes separately.
- Po completed tasks assigned to other teammates (2, 3, 5, 6) because those teammates hadn't claimed them yet. Agent scheduling is non-deterministic — the first agent to call TaskList and claim wins.
- SQLite migration logic: when a migration drops a table, add an early `return` to prevent subsequent ALTER TABLE clauses from running on the freshly recreated table.
