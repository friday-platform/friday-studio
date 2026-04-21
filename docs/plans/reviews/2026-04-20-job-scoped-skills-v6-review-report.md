# Job-scoped skills — v6 Review Report

**Reviewed:** 2026-04-20
**Input:** `docs/plans/2026-04-20-job-scoped-skills.v6.md`
**Output:** `docs/plans/2026-04-20-job-scoped-skills.v7.md`
**Prior reviews:** v1–v5 review reports under `reviews/`.

## TL;DR

v6 fixed the architectural claim (YAML isn't source of truth) but
didn't audit the co-located adapter queries. A careful re-read
of `local-adapter.ts` found **five concrete SQL bugs** that would
ship silently on the v6 plan: `listAssigned` leaking job-level rows
into workspace-wide visibility, `unassignSkill` destroying job-level
rows as a side effect, `listAssignments` returning duplicates,
`assignSkill` potentially inserting duplicate workspace-level rows,
and the migration `SELECT` lacking explicit `job_name` projection.

v7 adds **Phase A.1.5** (query audit) and a **partial unique index**
that together resolve Open Q #1 and the five bugs. Two regression
tests (F.2) formalize the audit.

## Context Gathered

Read every query touching `skill_assignments`:

- `local-adapter.ts:89` (migration copy) — SELECTs existing columns
  without projecting a new `job_name`. v7 spells out `NULL AS
  job_name` in the INSERT.
- `local-adapter.ts:442` (`deleteSkill`) — DELETEs all rows for
  `skill_id`. Correct; no fix.
- `local-adapter.ts:462` (`listUnassigned`) — LEFT JOIN with
  `sa.skill_id IS NULL`. Correct; zero assignments = global.
- `local-adapter.ts:483` (`listAssigned`) — INNER JOIN on
  `workspace_id = ?`. **Missing `AND sa.job_name IS NULL` filter.**
- `local-adapter.ts:498` (`assignSkill`) — `INSERT OR IGNORE (skill_id,
  workspace_id)`. Under NULL-distinct PK, two calls create two rows.
- `local-adapter.ts:506` (`unassignSkill`) — DELETE by skill+workspace.
  **Missing `AND job_name IS NULL` filter.**
- `local-adapter.ts:516` (`listAssignments`) — SELECT workspace_id.
  **Missing `DISTINCT` for the dual-level case.**

Five of these are load-bearing for v6's plan. v7's A.1.5 phase +
partial unique index fix all of them.

## Ideas Proposed (5, all accepted)

### 1. `listAssigned` leaks job-level rows (CRITICAL)

v6's migration adds the column; v6's plan didn't touch `listAssigned`.
After migration, `listAssigned(workspaceId)` includes workspace-level
AND job-level rows. Workspace chat, conversation agent, workspace
skills page — all see job-level skills. Exact opposite of isolation.

**v7 fix:** `AND sa.job_name IS NULL` filter. Listed in A.1.5 audit
table. F.2 regression test asserts the filter.

### 2. `unassignSkill` destroys job-level rows

`unassignSkill(X, ws)` today means "remove workspace-level X from
ws." After migration, DELETE with only `(skill_id, workspace_id)`
filter also wipes `(X, ws, 'job-a')`, `(X, ws, 'job-b')`, etc. User
detaches X at workspace level → silently loses all job-level X
assignments.

**v7 fix:** `AND job_name IS NULL` filter. A.1.5 + F.2 regression.

### 3. `listAssignments` returns duplicates

If (X, ws, NULL) AND (X, ws, 'job-a') both exist, `listAssignments(X)`
returns `[ws, ws]`. UI "this skill is in these N workspaces" shows
duplicates.

**v7 fix:** `SELECT DISTINCT workspace_id`. A.1.5 + F.2 regression.

### 4. `assignSkill` may create duplicate workspace-level rows

Under standard SQL (NULL is distinct), PK `(skill_id, workspace_id,
job_name)` allows two `(X, ws, NULL)` rows. `INSERT OR IGNORE` doesn't
help because there's no conflict to detect.

**v7 fix:** `CREATE UNIQUE INDEX ... WHERE job_name IS NULL`
(partial index). Enforces uniqueness of workspace-level rows
regardless of how `@db/sqlite` treats NULL in PKs. Also resolves
v6 Open Q #1 (which was kicking this can forward).

### 5. Migration SELECT doesn't project `job_name`

The INSERT at A.1's rebuild step does
`INSERT INTO skill_assignments_new (skill_id, workspace_id,
job_name, created_at) SELECT skill_id, workspace_id, created_at
FROM skill_assignments`. Column count mismatch — bug.

**v7 fix:** Explicit `SELECT skill_id, workspace_id, NULL AS
job_name, created_at`. Mechanical fix; documented in A.1.

### Rejected / Not Adopted

None — all five real bugs; all five integrated.

## Why v6 Missed These

v6's review report said "correct and implementable without further
plan-space iteration." That was wrong — co-located query bugs aren't
architecture, they're implementation correctness. The bar my v5
review set ("something the implementer would concretely fail without")
was the right bar; I just didn't apply it to the SQL layer.

Lesson for the next review: when a migration adds a column, audit
every existing query on that table for the new column's semantics.
Add this as a checklist step in any future schema-migration plan.

## Other v6 → v7 Adjustments

- **A.1.5 is a new phase** — 30 min of mechanical query review.
  Could be folded into A.1, kept as distinct so the checklist is
  visible in the phase table.
- **F.2 expanded** — four new regression tests, one per audit fix
  (bug 1–4). Adds 30 min. Bug 5 (migration SELECT) is covered by
  the existing "migration test" v6 already had.
- **Partial unique index** added to SCHEMA + migration path.
  Resolves Open Q #1 concretely instead of deferring.
- **Open Q #1 now marked resolved** in v7 (was deferred in v6).
- **Total estimate unchanged** at ~13 h. A.1.5 adds 30 min but
  replaces what would have been discovered-and-patched work
  during F.2 test writing.

## Caveats & Tradeoffs

- **Partial unique index is SQLite-specific.** Other SQL engines
  handle `NULL` in indexes differently. This codebase targets SQLite
  (via `@db/sqlite`) so it's fine, but the migration pattern would
  need revisiting if a future backend swap happens.
- **A.1.5 is mechanical but must be followed.** If someone skips the
  audit checklist, bugs 1–4 ship silently. F.2 regression tests are
  the safety net — failing test catches it.
- **Bug 4's partial index is the only non-obvious change.** A future
  maintainer might not immediately understand why there's both a
  composite PK AND a partial unique index. Comment on the index
  creation explaining the NULL-distinct sidestep.

## Unresolved Questions (carried forward)

1. **~~`@db/sqlite` NULL-in-PK behavior~~** (resolved in v7 via
   partial unique index)
2. **Simultaneous scoping API writes** — PK + partial index reject
   duplicates; partial-success response covers the error. F.2
   verifies.
3. **Ad-hoc runtime-dispatched jobs not in YAML** — resolver returns
   workspace-level only. F.2 test.

## Overlap with Prior Reviews

- **v1 ideas** — obsolete after v3 pivot
- **v2 ideas** — documented
- **v3 ideas** — integrated in v4
- **v4 ideas** — integrated in v5
- **v5 ideas** (my prior pass) — integrated in v6
- **v6 ideas** (this pass) — integrated in v7

## Pattern observation for future plan reviews

v4 review said "review further and you're gold-plating."
v5 review said "verify factual claims about current state."
v6 review (this one) says: "audit co-located queries when you change
a schema."

Each pass taught the reviewer something new. A plan isn't "done"
just because prior passes declared it done — a plan is done when
an implementer can follow it mechanically without failing. v7 is
the first version I'd say that about with confidence.

If v8 is requested: the bar rises to "what test would fail?" If
you can't name a failing test or concrete bug, it's gold-plating.
